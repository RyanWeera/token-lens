import type { EngineInterface, Register } from 'claude-code'

import { buildCheckpoint, cpKey, doomed, forProject, formatCheckpoint, tuneInstructions } from './checkpoint'
import type { Checkpoint, Msg } from './checkpoint'

const DAY = 24 * 3600 * 1000
const MAX_PER_RUN = 3 // plugins turned off in one run
const APPLY_EVERY = 7 * DAY
const HELP = `Local only, nothing is sent anywhere and nothing runs in the background.
/tokens [days]       token and cost report from your transcripts (default 30 days)
/tokens audit        find context waste in CLAUDE.md, skills, agents and MCP servers (read only)
/tokens plan         show which plugins it would turn off, and why (changes nothing)
/tokens auto [on|off|run|status]  automatic tuning (default on). run = analyse and apply now
/tokens undo         turn back on every plugin token-lens turned off
/tokens checkpoint   save a summary of this session now
/tokens checkpoints  list this project's checkpoints
/tokens restore      show the newest checkpoint and add it to the conversation
/tokens purge        delete everything token-lens stored (checkpoints, backups, change log)
Automatic actions, each shown on screen when it happens:
- before a compaction: saves a checkpoint and tells the summarizer what to keep (unless you gave instructions)
- after a compaction: adds the checkpoint back to the conversation
- once a day at session start: reads your transcripts; once a week it may turn off enabled plugins you have not used in 30 days (skills, commands, agents or MCP only; never plugins with hooks) in settings.json, after a backup. /tokens undo reverses it.`

type Auto = { off?: boolean; lastRun?: number; lastApply?: number }
type Change = { at: number; id: string; file?: string } // `file` is missing in entries logged by 0.2.0
type Plan = { days: number; sessions: number; compactions: number; settingsPath: string; candidates: { id: string; tokens: number; skills: number; agents: number; servers: number }[] }

// Runs the mod's own scan.mjs, never anything found elsewhere. Read only. The working directory is the mod's own
// folder, so a program lookup never starts in the project the session opened.
async function scan($: EngineInterface, args: string[]): Promise<string> {
  const r = await $.process.run(['node', `${$.plugin.root}/hooks/scan.mjs`, ...args], { timeoutMs: 120_000, cwd: $.plugin.root })
  return r.exitCode === 0 ? r.stdout : `token-lens: scan failed (exit ${r.exitCode}): ${r.stderr.slice(0, 500).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\xad\u061c\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, '')}`
}

async function getPlan($: EngineInterface): Promise<Plan | string> {
  const out = await scan($, ['plan', '30'])
  try { return JSON.parse(out) as Plan } catch { return out }
}

async function save($: EngineInterface, msgs: readonly Msg[]): Promise<Checkpoint> {
  const [root, sid, at] = await Promise.all([$.session.root(), $.session.id(), $.clock.now()])
  const cp = buildCheckpoint(msgs, at, sid, root)
  await $.store.set(cpKey(root, at), cp)
  for (const k of doomed(await $.store.keys(), at)) await $.store.delete(k)
  return cp
}

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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'tokens',
      description: 'Token usage report, automatic tuning, setup audit and session checkpoints (token-lens)',
      argumentHint: '[days | audit | plan | auto | undo | checkpoint | checkpoints | restore | purge | help]',
      immediate: true,
    })
    const now = await $.clock.now()
    for (const k of doomed(await $.store.keys(), now)) await $.store.delete(k)
    // 0.2.0 kept the whole settings.json in a backup. Keep only the plugin flags.
    for (const i of [0, 1, 2]) {
      const b = (await $.store.get(`backup:${i}`)) as { at: number; file: string; text?: string } | undefined
      if (b?.text === undefined) continue
      let flags: unknown
      try { flags = (JSON.parse(b.text) as { enabledPlugins?: unknown }).enabledPlugins } catch { /* none */ }
      await $.store.set(`backup:${i}`, { at: b.at, file: b.file, enabledPlugins: flags })
    }
    // Once, a few seconds after start, so the first prompt is not held. Not a repeating timer.
    $.clock.after(5_000, async () => {
      try {
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
  // After the compaction the checkpoint is added back as a labelled row. Never skips or blocks a compaction.
  on('session.compact', { trigger: /^(manual|auto|plugin)$/ }, async ($, e, next) => {
    const st = ((await $.store.get('auto')) as Auto | undefined) ?? {}
    let cp: Checkpoint | undefined
    if (!e.agentId) {
      try {
        cp = await save($, e.messages as readonly Msg[])
      } catch {
        // a failed save never stops a compaction
      }
    }
    const tune = cp && !st.off && !e.instructions
    if (tune) $.ui.log(`token-lens: told the summarizer what to keep: ${tuneInstructions(cp!).slice(0, 160)}`)
    const r = await next(tune ? { ...e, instructions: tuneInstructions(cp!) } : e)
    if (cp && !('skip' in r && r.skip)) {
      if (st.off) {
        $.ui.toast('token-lens: checkpoint saved. /tokens restore adds it back to the conversation.')
      } else {
        await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: `[token-lens, added automatically after compaction; /tokens auto off stops this]\n${formatCheckpoint(cp)}` }] } })
        $.ui.log('token-lens: checkpoint added back to the conversation after compaction.')
      }
    }
    return r
  }).catch(($, e, next) => next(e)) // a failing hook never blocks a compaction

  on('command.run', { command: 'tokens' }, async ($, e) => {
    const [cmd = '', rest = ''] = e.args.trim().split(/\s+/)
    if (cmd === '' || /^\d+$/.test(cmd)) return { text: await scan($, ['usage', cmd || '30']) }
    if (cmd === 'help') return { text: HELP }
    if (cmd === 'audit') return { text: await scan($, ['audit', await $.session.cwd()]) }
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
      const cp = await save($, (await $.session.messages()) as readonly Msg[])
      return { text: `Saved.\n${formatCheckpoint(cp)}` }
    }
    const keys = forProject(await $.store.keys(), await $.session.root())
    if (cmd === 'checkpoints') {
      const rows = await Promise.all(keys.map(async k => ((await $.store.get(k)) as Checkpoint | undefined)))
      return { text: rows.length ? rows.map(c => `${new Date(c?.at ?? 0).toISOString()}  ${c?.task.slice(0, 80) ?? ''}`).join('\n') : 'No checkpoints for this project.' }
    }
    if (cmd === 'restore') {
      const cp = keys.length ? ((await $.store.get(keys[0])) as Checkpoint | undefined) : undefined
      if (!cp) return { text: 'No checkpoint for this project.' }
      const text = formatCheckpoint(cp)
      return { text, context: [text] }
    }
    if (cmd === 'purge') {
      const all = await $.store.keys()
      for (const k of all) await $.store.delete(k)
      return { text: `Deleted ${all.length} stored item(s): checkpoints, settings backups, the change log and the automatic-tuning state. settings.json itself is not touched. /tokens undo no longer works.` }
    }
    return { text: `Unknown option "${`${cmd} ${rest}`.trim()}".\n${HELP}` }
  })
}
