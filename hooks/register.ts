import type { EngineInterface, Register } from 'claude-code'

import { buildCheckpoint, cpKey, doomed, forProject, formatCheckpoint, tuneInstructions } from './checkpoint'
import type { Checkpoint, Msg } from './checkpoint'
import { compress, EXPAND, reread } from './compress'
import type { Seen } from './compress'
import { NUDGES, nudges } from './nudges'
import type { Nudge, NudgeState } from './nudges'
import { formatBreakdown, formatQuality, quality } from './quality'
import type { Quality } from './quality'

const MIN = 60_000
const DAY = 24 * 60 * MIN
const MAX_PER_RUN = 3 // plugins turned off in one run
const APPLY_EVERY = 7 * DAY
const CP_EVERY = 20 * MIN // after an ordinary answer
const CP_AFTER_FAIL = 2 * MIN // after a failed or stopped turn
const CP_BEFORE_AGENT = 10 * MIN
const ARC_KEEP = 30 // archived full outputs kept, newest first
const ARC_TTL = 3 * DAY
const ARC_CHARS = 300_000
const LIST_KEEP = 150 // file names a search result keeps
const EXPAND_CHARS = 40_000
const SEEN_MAX = 200
const SESS_TTL = 14 * DAY
const HELP = `Local only. Nothing is sent anywhere and nothing runs in the background.
Reports (they read your transcripts and change nothing):
/tokens [days]           token and cost report (default 30 days)
/tokens quality          this session's grade, S to F, and what drags it down
/tokens report           this session's context, part by part
/tokens conversation     this session's cost, prompt by prompt
/tokens quick            today, this week and the top suggestion
/tokens trends [days]    cost and cache hit rate per day
/tokens drift            this week against the week before
/tokens coach [days]     waste patterns and what to do about them
/tokens route [days]     turns that a smaller model could have done
/tokens dashboard [days] write a local HTML dashboard and open it
/tokens memory           review the MEMORY.md files of this project
/tokens git              what the uncommitted changes cost to read
/tokens doctor           check the setup
/tokens audit            context waste in CLAUDE.md, skills, agents and MCP servers
/tokens plan             which plugins automatic tuning would turn off, and why
Settings:
/tokens auto [on|off|run|status]                  automatic tuning (default on)
/tokens undo                                      turn back on every plugin token-lens turned off
/tokens compress [bash|search|read] [on|off]      tool output compression (default on)
/tokens nudge [lean|quality|loop|route|all] [on|off]  hints added to your prompts (default off)
Checkpoints:
/tokens checkpoint       save a summary of this session now
/tokens checkpoints      list this project's checkpoints
/tokens restore [n]      add the newest (or the n-th) checkpoint to the conversation
/tokens purge            delete everything token-lens stored
Automatic actions, each labelled where it happens:
- long Bash and search output is folded (repeated lines, colour codes, the middle of very long output); the label names the id that gets the full text back through the token-lens expand tool
- a repeat Read of the same lines within 30 minutes returns an outline when the file is unchanged, or only the changed lines
- checkpoints: before a compaction, before a subagent, after a failed turn, at session end, and every 20 minutes of work
- before a compaction: tells the summarizer what to keep (unless you gave instructions); after it: adds the checkpoint back
- after each answer and each compaction: writes this session's grade to ~/.claude/token-lens/ (crab-progress and project-link read it)
- once a day at session start: reads your transcripts; once a week it may turn off enabled plugins you have not used in 30 days (skills, commands, agents or MCP only; never plugins with hooks) in settings.json, after a backup. /tokens undo reverses it.`

type Auto = { off?: boolean; lastRun?: number; lastApply?: number }
type Change = { at: number; id: string; file?: string } // `file` is missing in entries logged by 0.2.0
type Plan = { days: number; sessions: number; compactions: number; settingsPath: string; candidates: { id: string; tokens: number; skills: number; agents: number; servers: number }[] }
type Part = 'bash' | 'search' | 'read'
const PARTS: Part[] = ['bash', 'search', 'read']
type Cfg = { compress?: Partial<Record<Part, boolean>>; nudges?: Nudge[] }
type Sess = { at: number; start?: number; compactions?: number; nudge?: NudgeState; quality?: Quality; cpAt?: number; agentCpAt?: number }
type Savings = { days?: Record<string, number>; sessions?: Record<string, number> }

// The last full Read of each range, per session and agent, held in memory only. A withheld repeat Read is
// archived in the store like folded output (3 days). Losing this map (a reload) only means the next Read goes through whole.
const seen = new Map<string, Seen>()

const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10)
const stampOf = (k: string) => Number(k.split(':')[1])
const getCfg = async ($: EngineInterface) => ((await $.store.get('cfg')) as Cfg | undefined) ?? {}
const isOn = (c: Cfg, p: Part) => c.compress?.[p] !== false
const getSess = async ($: EngineInterface, sid: string) => ((await $.store.get(`sess:${sid}`)) as Sess | undefined) ?? { at: 0 }
async function patchSess($: EngineInterface, sid: string, fn: (s: Sess) => Sess) {
  await $.store.set(`sess:${sid}`, fn(await getSess($, sid)))
}

// Runs the mod's own scan.mjs, never anything found elsewhere. The working directory is the mod's own
// folder, so a program lookup never starts in the project the session opened.
async function scan($: EngineInterface, args: string[]): Promise<string> {
  const r = await $.process.run(['node', `${$.plugin.root}/hooks/scan.mjs`, ...args], { timeoutMs: 120_000, cwd: $.plugin.root })
  return r.exitCode === 0 ? r.stdout : `token-lens: scan failed (exit ${r.exitCode}): ${r.stderr.slice(0, 500).replace(/(?![\t\n])[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/gu, '')}`
}

async function getPlan($: EngineInterface): Promise<Plan | string> {
  const out = await scan($, ['plan', '30'])
  try { return JSON.parse(out) as Plan } catch { return out }
}

async function save($: EngineInterface, msgs: readonly Msg[], why?: string): Promise<Checkpoint> {
  const [root, sid, at] = await Promise.all([$.session.root(), $.session.id(), $.clock.now()])
  const cp = buildCheckpoint(msgs, at, sid, root, why)
  await $.store.set(cpKey(root, at), cp)
  for (const k of doomed(await $.store.keys(), at)) await $.store.delete(k)
  return cp
}

// ~/.claude/token-lens: the one folder token-lens writes files into, besides settings.json.
async function dataDir($: EngineInterface): Promise<string | null> {
  const conf = await $.env.get('CLAUDE_CONFIG_DIR')
  const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME'))
  const claude = conf || (home ? `${home}/.claude` : '')
  return claude ? `${claude.replace(/[\\/]+$/, '')}/token-lens` : null
}

// ---- savings and the archive of full outputs ----

async function credit($: EngineInterface, chars: number) {
  const tokens = Math.round(chars / 4)
  if (tokens <= 0) return
  const [sid, now] = await Promise.all([$.session.id(), $.clock.now()])
  const s = ((await $.store.get('savings')) as Savings | undefined) ?? {}
  const d = dayOf(now)
  const days = Object.entries({ ...s.days, [d]: (s.days?.[d] ?? 0) + tokens }).sort((a, b) => a[0].localeCompare(b[0])).slice(-30)
  const { [sid]: mine = 0, ...others } = s.sessions ?? {}
  await $.store.set('savings', { days: Object.fromEntries(days), sessions: Object.fromEntries(Object.entries({ ...others, [sid]: mine + tokens }).slice(-50)) })
}

function savingsView(s: Savings, sid: string, now: number) {
  const daily = Array.from({ length: 30 }, (_, i) => {
    const date = dayOf(now - (29 - i) * DAY)
    return { date, tokens: s.days?.[date] ?? 0 }
  })
  return { session_tokens: s.sessions?.[sid] ?? 0, total_30d_tokens: daily.reduce((a, x) => a + x.tokens, 0), daily }
}

const getSavings = async ($: EngineInterface) => ((await $.store.get('savings')) as Savings | undefined) ?? {}

async function pruneArchive($: EngineInterface, now: number) {
  const keys = (await $.store.keys()).filter(k => k.startsWith('arc:')).sort((a, b) => stampOf(b) - stampOf(a))
  for (const [i, k] of keys.entries()) if (i >= ARC_KEEP || !(now - stampOf(k) <= ARC_TTL)) await $.store.delete(k)
}

async function archive($: EngineInterface, id: string, text: string) {
  const now = await $.clock.now()
  await $.store.set(`arc:${now}:${id}`, text.slice(0, ARC_CHARS))
  await pruneArchive($, now)
}

// ---- after each answer: grade, checkpoint, quality file ----

async function earlierCheckpoint($: EngineInterface, root: string, sid: string) {
  for (const k of forProject(await $.store.keys(), root).slice(0, 5)) {
    const c = (await $.store.get(k)) as Checkpoint | undefined
    if (c && c.sid !== sid) return { epoch: Math.floor(c.at / 1000), about: c.task.slice(0, 120) }
  }
  return null
}

async function afterTurn($: EngineInterface, why: string) {
  const [sid, now, root, use] = await Promise.all([$.session.id(), $.clock.now(), $.session.root(), $.session.usage()])
  const msgs = (await $.session.messages()) as readonly Msg[]
  const s = await getSess($, sid)
  const fill = typeof use.context.percent === 'number' ? Math.round(use.context.percent) : null
  const q = quality(msgs, fill, s.compactions ?? 0)
  const failed = why === 'error' || why === 'aborted'
  let cpAt = s.cpAt
  if (msgs.some(m => m.toolUses.length) && now - (cpAt ?? 0) >= (failed ? CP_AFTER_FAIL : CP_EVERY)) {
    await save($, msgs, failed ? `turn ${why}` : 'periodic')
    cpAt = now
  }
  await patchSess($, sid, x => ({ ...x, at: now, start: use.startedAt, quality: q, cpAt }))
  const dir = await dataDir($)
  if (!dir || !/^[\w-]+$/.test(sid)) return
  const sec = (ms?: number) => (ms ? Math.floor(ms / 1000) : null)
  const status = {
    savings: savingsView(await getSavings($), sid, now),
    savings_state: 'fresh',
    savings_reason: null,
    last_checkpoint_epoch: sec(cpAt),
    earlier_checkpoint: await earlierCheckpoint($, root, sid),
    compactions: q.compactions,
  }
  await $.fs.write(`${dir}/quality-${sid}.json`, JSON.stringify({ ...q, session_start_ts: sec(use.startedAt), last_checkpoint_epoch: sec(cpAt), updated_epoch: sec(now), status }))
}

// ---- automatic tuning (settings.json enabledPlugins) ----

// Sets enabledPlugins flags in settings.json. The flags are copied to the store first, the result is re-read,
// and the original is put back if it no longer parses. Only flags that differ are changed; returns those ids.
async function setPlugins($: EngineInterface, path: string, ids: string[], value: boolean, now: number, limit = 99): Promise<string[]> {
  const raw = await $.fs.read(path)
  const settings = JSON.parse(raw) as { enabledPlugins?: Record<string, boolean> }
  const hit = [...new Set(ids)].filter(id => settings.enabledPlugins?.[id] === !value).slice(0, limit)
  if (!hit.length) return []
  const slot = Number(((await $.store.get('backup-next')) as number | undefined) ?? 0) % 3
  // Only the flags are kept: the rest of settings.json can hold secrets and does not belong in the store.
  await $.store.set(`backup:${slot}`, { at: now, file: path, enabledPlugins: settings.enabledPlugins })
  await $.store.set('backup-next', slot + 1)
  for (const id of hit) settings.enabledPlugins![id] = value
  try {
    await $.fs.write(path, JSON.stringify(settings, null, 2) + '\n')
    JSON.parse(await $.fs.read(path))
  } catch {
    await $.fs.write(path, raw)
    throw new Error('settings.json did not parse after the change; the original was put back')
  }
  return hit
}

// Turns off the plan's unused plugins and logs them, with the file, for /tokens undo.
async function applyPlan($: EngineInterface, plan: Plan, now: number): Promise<string[]> {
  const hit = await setPlugins($, plan.settingsPath, plan.candidates.map(c => c.id), false, now, MAX_PER_RUN).catch((err: unknown) => {
    $.ui.log(`token-lens: could not change settings.json: ${String(err).slice(0, 200)}`)
    return [] as string[]
  })
  if (!hit.length) return []
  const log = ((await $.store.get('changes')) as Change[] | undefined) ?? []
  await $.store.set('changes', [...log, ...hit.map(id => ({ at: now, id, file: plan.settingsPath }))].slice(-50))
  return hit.map(id => `${id} (~${plan.candidates.find(c => c.id === id)?.tokens ?? 0} tokens of descriptions)`)
}

// One analysis: reads transcripts, and when the person left it on, applies the plan.
async function autoRun($: EngineInterface, force: boolean): Promise<string> {
  const st = ((await $.store.get('auto')) as Auto | undefined) ?? {}
  const now = await $.clock.now()
  if (!force && (st.off || now - (st.lastRun ?? 0) < DAY)) return ''
  const plan = await getPlan($)
  if (typeof plan === 'string') return plan
  await $.store.set('auto', { ...st, lastRun: now })
  const sum = `token-lens learned from ${plan.sessions} sessions in ${plan.days} days (${plan.compactions} compactions).`
  if (!plan.candidates.length) return `${sum} Nothing to turn off.`
  if (!force && now - (st.lastApply ?? 0) < APPLY_EVERY) return `${sum} ${plan.candidates.length} unused plugin(s) found; next automatic change is due later. /tokens plan shows them.`
  const done = await applyPlan($, plan, now)
  if (!done.length) return `${sum} Nothing changed.`
  await $.store.set('auto', { ...st, lastRun: now, lastApply: now })
  return `${sum} Turned off unused plugins in settings.json: ${done.join(', ')}. Not used in 30 days. Takes effect on /reload-plugins or next start. /tokens undo turns them back on.`
}

// ---- tool output ----

type SearchResult = { content?: string; filenames?: string[] }

// Grep content is folded like Bash output; a long list of file names keeps its first LIST_KEEP.
async function foldSearch($: EngineInterface, id: string, res: SearchResult): Promise<{ res: SearchResult; label?: string } | null> {
  if (typeof res.content === 'string' && res.content) {
    const c = compress(res.content, id)
    if (!c) return null
    if (c.archived) await archive($, id, res.content)
    await credit($, res.content.length - c.text.length)
    return { res: { ...res, content: c.text } }
  }
  const names = res.filenames
  if (!Array.isArray(names) || names.length <= LIST_KEEP) return null
  const full = names.join('\n')
  await archive($, id, full)
  await credit($, full.length - names.slice(0, LIST_KEEP).join('\n').length)
  return { res: { ...res, filenames: names.slice(0, LIST_KEEP) }, label: `[token-lens: ${names.length - LIST_KEEP} more file names were folded out of this result. Full list: call ${EXPAND} with id "${id}". /tokens compress search off stops this]` }
}

const numbered = (content: string, start: number) => content.split('\n').map((l, i) => `${start + i}\t${l}`).join('\n')

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await Promise.all([
      $.command.register({
        name: 'tokens',
        description: 'Token reports, session grade, output compression, nudges, automatic tuning and checkpoints (token-lens)',
        argumentHint: '[days | quality | report | coach | dashboard | compress | nudge | checkpoint | restore | help]',
        immediate: true,
      }),
      $.tool.register({
        name: 'expand',
        description: 'Returns the full text that token-lens folded out of a tool result. Pass the id named in the fold label; from_line and lines read part of it.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'The id from the token-lens label.' },
            from_line: { type: 'integer', minimum: 1, description: 'First line to return (default 1).' },
            lines: { type: 'integer', minimum: 1, description: 'How many lines to return (default all).' },
          },
          required: ['id'],
        },
        isDeferred: false,
      }),
    ])
    const [now, root, sid, turns] = await Promise.all([$.clock.now(), $.session.root(), $.session.id(), $.session.turns()])
    const keys = await $.store.keys()
    for (const k of doomed(keys, now)) await $.store.delete(k)
    await pruneArchive($, now)
    for (const k of keys.filter(x => x.startsWith('sess:'))) {
      const s = (await $.store.get(k)) as Sess | undefined
      if (!s || now - (s.at ?? 0) > SESS_TTL) await $.store.delete(k)
    }
    // 0.2.0 kept the whole settings.json in a backup. Keep only the plugin flags.
    for (const i of [0, 1, 2]) {
      const b = (await $.store.get(`backup:${i}`)) as { at: number; file: string; text?: string } | undefined
      if (b?.text === undefined) continue
      let flags: unknown
      try { flags = (JSON.parse(b.text) as { enabledPlugins?: unknown }).enabledPlugins } catch { /* none */ }
      await $.store.set(`backup:${i}`, { at: b.at, file: b.file, enabledPlugins: flags })
    }
    // A new session in a project with a recent checkpoint from another session: say so, add nothing.
    if (turns === 0) {
      const key = forProject(keys, root)[0]
      const cp = key ? ((await $.store.get(key)) as Checkpoint | undefined) : undefined
      if (cp && cp.sid !== sid && now - cp.at < DAY) {
        const line = `token-lens: a checkpoint from ${new Date(cp.at).toISOString().slice(0, 16).replace('T', ' ')} UTC exists for this project ("${cp.task.slice(0, 80)}"). /tokens restore adds it to this conversation.`
        $.ui.log(line)
        $.ui.toast(line.slice(0, 200))
      }
    }
    // Once, a few seconds after start, so the first prompt is not held. Not a repeating timer.
    $.clock.after(5_000, async () => {
      try {
        if (now - Number((await $.store.get('pruned-at')) ?? 0) >= DAY) {
          await scan($, ['prune'])
          await $.store.set('pruned-at', now)
        }
        const line = await autoRun($, false)
        if (line) {
          $.ui.log(line)
          $.ui.toast(line.slice(0, 200))
        }
      } catch (err) {
        $.ui.log(`token-lens: automatic analysis failed: ${String(err).slice(0, 200)}`)
      }
    })
    return next(e)
  })

  // The checkpoint is saved first. Unless the person gave instructions, the summarizer is told what this session needs kept.
  // After the compaction the checkpoint is added back as a labelled row and the quality file is written again.
  // Never skips or blocks a compaction.
  on('session.compact', { trigger: /^(manual|auto|plugin)$/ }, async ($, e, next) => {
    const st = ((await $.store.get('auto')) as Auto | undefined) ?? {}
    const sid = await $.session.id()
    let cp: Checkpoint | undefined
    if (!e.agentId) {
      try {
        cp = await save($, e.messages as readonly Msg[], 'compaction')
      } catch {
        // a failed save never stops a compaction
      }
    }
    const tune = cp && !st.off && !e.instructions
    if (tune) $.ui.log(`token-lens: told the summarizer what to keep: ${tuneInstructions(cp!).slice(0, 160)}`)
    const r = await next(tune ? { ...e, instructions: tuneInstructions(cp!) } : e)
    if ('skip' in r && r.skip) return r
    try {
      // Earlier reads are gone from the context now, so a repeat Read must go through whole again.
      for (const k of [...seen.keys()]) if (k.startsWith(`${sid}|${e.agentId ?? ''}|`)) seen.delete(k)
      if (!e.agentId) await patchSess($, sid, s => ({ ...s, compactions: (s.compactions ?? 0) + 1, cpAt: cp ? cp.at : s.cpAt }))
      if (cp && st.off) $.ui.toast('token-lens: checkpoint saved. /tokens restore adds it back to the conversation.')
      if (cp && !st.off) {
        await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: `[token-lens, added automatically after compaction; /tokens auto off stops this]\n${formatCheckpoint({ ...cp, reads: [], errors: [] })}` }] } })
        $.ui.log('token-lens: checkpoint added back to the conversation after compaction.')
      }
    } catch (err) {
      $.ui.log(`token-lens: after the compaction: ${String(err).slice(0, 160)}`)
    }
    // The crab band reads the quality file right after a compaction, so it gets the new checkpoint time now.
    if (!e.agentId) await afterTurn($, 'compaction').catch(err => $.ui.log(`token-lens: could not write the quality file: ${String(err).slice(0, 160)}`))
    return r
  }).catch(($, e, next) => next(e)) // a failing hook never blocks a compaction

  // After each answer of the main conversation: the grade, a checkpoint when one is due, the quality file.
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId || e.reason === 'refusal') return r
    try {
      await afterTurn($, e.reason)
    } catch (err) {
      $.ui.log(`token-lens: could not grade this turn: ${String(err).slice(0, 160)}`)
    }
    return r
  })

  // A checkpoint before a subagent starts, at most every 10 minutes. Never holds or changes the spawn.
  on('agent.spawn', async ($, e, next) => {
    try {
      const [sid, now] = await Promise.all([$.session.id(), $.clock.now()])
      if (now - ((await getSess($, sid)).agentCpAt ?? 0) >= CP_BEFORE_AGENT) {
        const cp = await save($, (await $.session.messages()) as readonly Msg[], `before subagent: ${e.description.slice(0, 80)}`)
        await patchSess($, sid, s => ({ ...s, cpAt: cp.at, agentCpAt: cp.at }))
      }
    } catch {
      // a failed save never stops a subagent
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    try {
      const [sid, now] = await Promise.all([$.session.id(), $.clock.now()])
      const msgs = (await $.session.messages()) as readonly Msg[]
      if (msgs.some(m => m.toolUses.length) && now - ((await getSess($, sid)).cpAt ?? 0) >= CP_AFTER_FAIL) await save($, msgs, 'session end')
    } catch {
      // nothing to do: the session is ending
    }
    return next(e)
  })

  // Nudges are off until the person turns one on. Each is labelled in the text the model reads and on screen.
  on('prompt.submit', async ($, e, next) => {
    let lines: string[] = []
    try {
      const cfg = await getCfg($)
      if (cfg.nudges?.length && !e.command && !e.isMeta) {
        const [sid, now, model, use] = await Promise.all([$.session.id(), $.clock.now(), $.session.model(), $.session.usage()])
        const msgs = (await $.session.messages()) as readonly Msg[]
        const s = await getSess($, sid)
        const prompts = [...msgs.filter(m => m.role === 'user' && m.text.trim() && !m.text.trimStart().startsWith('<')).slice(-4).map(m => m.text), e.text]
        const uses = msgs.flatMap(m => (m.role === 'assistant' ? m.toolUses : [])).map(u => ({
          tool: u.tool,
          command: typeof u.input.command === 'string' ? u.input.command : undefined,
          isError: u.isError === true && !u.text?.includes('[token-lens'),
        }))
        const fill = typeof use.context.percent === 'number' ? Math.round(use.context.percent) : null
        const out = nudges({ on: cfg.nudges, now, fill, score: s.quality?.score ?? null, drag: s.quality?.top_drag?.label ?? null, prompts, uses, model }, s.nudge ?? {})
        await patchSess($, sid, x => ({ ...x, nudge: out.st }))
        lines = out.lines
      }
    } catch {
      lines = []
    }
    if (!lines.length) return next(e)
    const names = [...new Set(lines.map(l => /nudge: (\w+)/.exec(l)?.[1] ?? ''))].join(', ')
    $.ui.toast(`token-lens nudge (${names}) added to this prompt. /tokens nudge ${names.split(',')[0]} off stops it.`)
    return next({ ...e, context: [...(e.context ?? []), ...lines] })
  })

  // Bash: repeated lines, colour codes and progress redraws folded; very long output cut to its start and end.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const r = await next(e)
    try {
      if (!('result' in r) || !r.result || r.isError) return r
      const res = r.result as { stdout?: unknown; isImage?: boolean; backgroundTaskId?: string; persistedOutputPath?: string }
      if (typeof res.stdout !== 'string' || res.isImage || res.backgroundTaskId || res.persistedOutputPath) return r
      if (!isOn(await getCfg($), 'bash')) return r
      const c = compress(res.stdout, e.tool_use_id)
      if (!c) return r
      if (c.archived) await archive($, e.tool_use_id, res.stdout)
      await credit($, res.stdout.length - c.text.length)
      return { result: { ...res, stdout: c.text } as typeof r.result, ...(r.context ? { context: r.context } : {}) }
    } catch {
      return r
    }
  })

  on('tool.call', { tool: 'Grep' }, async ($, e, next) => {
    const r = await next(e)
    try {
      if (!('result' in r) || !r.result || r.isError || !isOn(await getCfg($), 'search')) return r
      const f = await foldSearch($, e.tool_use_id, r.result as SearchResult)
      if (!f) return r
      return { result: f.res as typeof r.result, context: [...(r.context ?? []), ...(f.label ? [f.label] : [])] }
    } catch {
      return r
    }
  })

  on('tool.call', { tool: 'Glob' }, async ($, e, next) => {
    const r = await next(e)
    try {
      if (!('result' in r) || !r.result || r.isError || !isOn(await getCfg($), 'search')) return r
      const f = await foldSearch($, e.tool_use_id, r.result as SearchResult)
      if (!f) return r
      return { result: f.res as typeof r.result, context: [...(r.context ?? []), ...(f.label ? [f.label] : [])] }
    } catch {
      return r
    }
  })

  // A repeat Read of the same lines in this context: the result is withheld with a note in its place
  // (an outline when unchanged, the changed lines when a small part changed). The full text is archived.
  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    const r = await next(e)
    try {
      if (!('result' in r) || !r.result || r.isError) return r
      const res = r.result as { type?: string; file?: { filePath?: string; content?: unknown; startLine?: number } }
      const file = res.type === 'text' ? res.file : undefined
      if (!file || typeof file.content !== 'string' || !isOn(await getCfg($), 'read')) return r
      const [sid, now] = await Promise.all([$.session.id(), $.clock.now()])
      const range = e as unknown as { offset?: number; limit?: number }
      const key = `${sid}|${e.agentId ?? ''}|${file.filePath ?? ''}|${range.offset ?? ''}|${range.limit ?? ''}`
      const prev = seen.get(key)
      const start = file.startLine ?? 1
      const note = reread(prev, file.content, start, now, e.tool_use_id)
      if (!note) {
        seen.delete(key)
        if (file.content.length <= ARC_CHARS) seen.set(key, { at: now, content: file.content })
        while (seen.size > SEEN_MAX) seen.delete(seen.keys().next().value!)
        return r
      }
      // After a delta the context holds the old copy plus the changes, so the next Read goes through whole.
      if (prev!.content !== file.content) seen.delete(key)
      await archive($, e.tool_use_id, numbered(file.content, start))
      await credit($, file.content.length - note.length)
      return { deny: note }
    } catch {
      return r
    }
  })

  on('tool.call', { tool: EXPAND }, async ($, e) => {
    const input = e as unknown as { id?: unknown; from_line?: unknown; lines?: unknown }
    const id = typeof input.id === 'string' && /^[\w-]{1,120}$/.test(input.id) ? input.id : ''
    const key = id ? (await $.store.keys()).find(k => k.startsWith('arc:') && k.endsWith(`:${id}`)) : undefined
    const text = key ? ((await $.store.get(key)) as string | undefined) : undefined
    if (!text) return { result: `token-lens: nothing is archived under id "${String(input.id).slice(0, 120)}". Archives are kept 3 days, newest ${ARC_KEEP}.` }
    const all = text.split('\n')
    const from = Math.max(1, Math.floor(Number(input.from_line) || 1))
    const count = Math.max(1, Math.floor(Number(input.lines) || all.length))
    const rows = all.slice(from - 1, from - 1 + count)
    let out = ''
    let shown = 0
    for (const row of rows) {
      if (out.length + row.length > EXPAND_CHARS && shown) break
      out += (shown ? '\n' : '') + row
      shown++
    }
    const last = from + shown - 1
    const more = last < Math.min(all.length, from - 1 + count) ? `\n[token-lens: lines ${from}-${last} of ${all.length}. Call again with from_line ${last + 1} for more.]` : ''
    const cut = text.length >= ARC_CHARS ? `\n[token-lens: the archive kept the first ${ARC_CHARS} characters of this output.]` : ''
    return { result: out + more + cut }
  })

  on('command.run', { command: 'tokens' }, async ($, e) => {
    const [cmd = '', rest = '', third = ''] = e.args.trim().split(/\s+/)
    const days = (x: string) => String(Math.min(365, Math.max(1, Number(x) || 30)))
    if (cmd === '' || /^\d+$/.test(cmd)) return { text: await scan($, ['usage', days(cmd)]) }
    if (cmd === 'help') return { text: HELP }
    if (cmd === 'audit') return { text: await scan($, ['audit', await $.session.cwd()]) }
    if (cmd === 'trends' || cmd === 'coach' || cmd === 'route') return { text: await scan($, [cmd, days(rest)]) }
    if (cmd === 'drift') return { text: await scan($, ['drift']) }
    if (cmd === 'conversation' || cmd === 'quick' || cmd === 'doctor') return { text: await scan($, [cmd, await $.session.id()]) }
    if (cmd === 'memory' || cmd === 'git') return { text: await scan($, [cmd, await $.session.cwd()]) }
    if (cmd === 'dashboard') {
      const [sid, now] = await Promise.all([$.session.id(), $.clock.now()])
      return { text: await scan($, ['dashboard', days(rest), String(savingsView(await getSavings($), sid, now).total_30d_tokens)]) }
    }
    if (cmd === 'quality') {
      const [sid, now, use] = await Promise.all([$.session.id(), $.clock.now(), $.session.usage()])
      const fill = typeof use.context.percent === 'number' ? Math.round(use.context.percent) : null
      const q = quality((await $.session.messages()) as readonly Msg[], fill, (await getSess($, sid)).compactions ?? 0)
      const sv = savingsView(await getSavings($), sid, now)
      return { text: `${formatQuality(q)}\nSaved by token-lens compression: ${sv.session_tokens} tokens this session, ${sv.total_30d_tokens} in the last 30 days.` }
    }
    if (cmd === 'report') {
      const b = (await $.session.usage({ breakdown: 'summary' })).context.breakdown
      return { text: b ? formatBreakdown(b) : 'The context breakdown is not available in this session.' }
    }
    if (cmd === 'compress') {
      const cfg = await getCfg($)
      const part = (PARTS as string[]).includes(rest) ? (rest as Part) : null
      const value = part ? third : rest
      if ((rest && !part && rest !== 'on' && rest !== 'off') || (value && value !== 'on' && value !== 'off')) return { text: `Use: /tokens compress [bash|search|read] [on|off]` }
      if (value) await $.store.set('cfg', { ...cfg, compress: { ...cfg.compress, ...Object.fromEntries((part ? [part] : PARTS).map(p => [p, value === 'on'])) } })
      const now = await getCfg($)
      return { text: `Tool output compression: ${PARTS.map(p => `${p} ${isOn(now, p) ? 'on' : 'off'}`).join(', ')}. Saved tokens show in /tokens quality and the crab band.` }
    }
    if (cmd === 'nudge' || cmd === 'nudges') {
      const cfg = await getCfg($)
      const pick = rest === 'all' ? [...NUDGES] : (NUDGES as readonly string[]).includes(rest) ? [rest as Nudge] : null
      if ((rest && !pick) || (third && third !== 'on' && third !== 'off') || (pick && !third)) return { text: `Use: /tokens nudge [${NUDGES.join('|')}|all] [on|off]` }
      if (pick) {
        const set = new Set(cfg.nudges ?? [])
        for (const n of pick) (third === 'on' ? set.add(n) : set.delete(n))
        await $.store.set('cfg', { ...cfg, nudges: NUDGES.filter(n => set.has(n)) })
      }
      const onNow = new Set((await getCfg($)).nudges ?? [])
      return { text: `Nudges (hints added to your prompts, each labelled): ${NUDGES.map(n => `${n} ${onNow.has(n) ? 'on' : 'off'}`).join(', ')}.\nlean: short answers as the context fills. quality: when the grade drops. loop: repeated prompts, failing tools, repeated scripts. route: small edits on a large model.` }
    }
    if (cmd === 'plan') {
      const p = await getPlan($)
      if (typeof p === 'string') return { text: p }
      const list = p.candidates.map(c => `- ${c.id}: ${c.skills} skills, ${c.agents} agents, ${c.servers} MCP servers, ~${c.tokens} tokens of descriptions`).join('\n')
      return { text: `Analysed ${p.sessions} sessions over ${p.days} days.\n${p.sessions < 15 ? 'Too few sessions to judge. Nothing would change.' : list ? `Would turn off (enabled, not used in 30 days, no hooks):\n${list}` : 'Nothing to turn off.'}` }
    }
    if (cmd === 'auto') {
      const st = ((await $.store.get('auto')) as Auto | undefined) ?? {}
      if (rest === 'on' || rest === 'off') {
        await $.store.set('auto', { ...st, off: rest === 'off' })
        return { text: `Automatic tuning is ${rest}.` }
      }
      if (rest === 'run') return { text: (await autoRun($, true)) || 'Nothing to do.' }
      return { text: `Automatic tuning is ${st.off ? 'off' : 'on'}. Last analysis: ${st.lastRun ? new Date(st.lastRun).toISOString() : 'never'}. Last change: ${st.lastApply ? new Date(st.lastApply).toISOString() : 'never'}.` }
    }
    if (cmd === 'undo') {
      const log = ((await $.store.get('changes')) as Change[] | undefined) ?? []
      if (!log.length) return { text: 'Nothing to undo.' }
      const now = await $.clock.now()
      // 0.2.0 logged no file; its newest settings backup names the file it changed.
      const backups = (await Promise.all([0, 1, 2].map(i => $.store.get(`backup:${i}`)))) as ({ at: number; file: string } | undefined)[]
      const legacy = backups.filter(Boolean).sort((a, b) => b!.at - a!.at)[0]?.file
      const fileOf = (c: Change) => c.file ?? legacy ?? ''
      const back: string[] = []
      const failed = new Map<string, string>()
      for (const file of new Set(log.map(fileOf))) {
        try {
          if (!file) throw new Error('the settings file is unknown')
          back.push(...(await setPlugins($, file, log.filter(c => fileOf(c) === file).map(c => c.id), true, now)))
        } catch (err) {
          failed.set(file, String(err).slice(0, 120))
        }
      }
      // Entries whose file could not be updated stay in the log, so a later /tokens undo can try again.
      await $.store.set('changes', log.filter(c => failed.has(fileOf(c))))
      const bad = [...failed].map(([f, why]) => `${f || '(unknown file)'}: ${why}`)
      return { text: `${back.length ? `Turned back on: ${back.join(', ')}. /reload-plugins to apply.` : failed.size ? '' : 'No logged plugin was still turned off.'}${bad.length ? `\nCould not update: ${bad.join('; ')}` : ''}`.trim() }
    }
    if (cmd === 'checkpoint') {
      const cp = await save($, (await $.session.messages()) as readonly Msg[], 'by hand')
      await patchSess($, await $.session.id(), s => ({ ...s, cpAt: cp.at }))
      return { text: `Saved.\n${formatCheckpoint(cp)}` }
    }
    const keys = forProject(await $.store.keys(), await $.session.root())
    if (cmd === 'checkpoints') {
      const rows = await Promise.all(keys.map(async k => ((await $.store.get(k)) as Checkpoint | undefined)))
      return { text: rows.length ? rows.map((c, i) => `${i + 1}. ${new Date(c?.at ?? 0).toISOString().slice(0, 16).replace('T', ' ')}${c?.why ? ` [${c.why}]` : ''}  ${c?.task.slice(0, 80) ?? ''}`).join('\n') + '\n/tokens restore <n> adds one to the conversation.' : 'No checkpoints for this project.' }
    }
    if (cmd === 'restore') {
      const n = Math.max(1, Math.floor(Number(rest) || 1))
      const cp = keys[n - 1] ? ((await $.store.get(keys[n - 1])) as Checkpoint | undefined) : undefined
      if (!cp) return { text: keys.length ? `There are ${keys.length} checkpoint(s) for this project. /tokens checkpoints lists them.` : 'No checkpoint for this project.' }
      const text = formatCheckpoint(cp)
      return { text, context: [text] }
    }
    if (cmd === 'purge') {
      const all = await $.store.keys()
      for (const k of all) await $.store.delete(k)
      seen.clear()
      return { text: `Deleted ${all.length} stored item(s): checkpoints, archived outputs, savings, settings backups, the change log and all settings (compression is back on, nudges off). settings.json is not touched. /tokens undo no longer works. Quality files in ~/.claude/token-lens are removed after 14 days.` }
    }
    return { text: `Unknown option "${`${cmd} ${rest}`.trim()}".\n${HELP}` }
  })
}
