// Scanner for token-lens. Node standard library only. No network.
// It reads only, with two exceptions inside token-lens's own folder (~/.claude/token-lens): `dashboard` writes
// dashboard.html there and opens it, and `prune` deletes that folder's quality files older than 14 days.
// Usage: node scan.mjs usage <days> | audit <cwd> | plan <days> | trends <days> | drift | coach <days> | route <days>
//        | conversation <sid> | quick <sid> | doctor <sid> | memory <cwd> | git <cwd> | dashboard <days> [saved tokens] | prune
import { execFileSync, spawn } from 'node:child_process'
import { createReadStream, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

// On Windows a bare program name is otherwise looked up in the working folder first, so a git.exe that a
// repository ships could run in place of the real git.
if (process.platform === 'win32') process.env.NoDefaultCurrentDirectoryInExePath = '1'

// Names come from files a repository controls: no control or escape characters reach the terminal.
// A name taken from a repository or config file is printed at most 80 characters long.
const cap = s => (s = String(s)).length > 80 ? `${s.slice(0, 77)}...` : s
const strip = t => t.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\xad\u061c\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, '')
// A regular file under 1 MB, read as text; null for anything else (a symlink, a directory, a device, a big file).
// True when no part of p below root is a symlink or junction (so a read never follows a link a repository planted).
const plain = (root, p) => {
  const rel = relative(root, p)
  if (rel.startsWith('..') || isAbsolute(rel)) return false
  let cur = root
  for (const seg of rel.split(sep)) {
    cur = join(cur, seg)
    try { if (lstatSync(cur).isSymbolicLink()) return false } catch { return false }
  }
  return true
}
const readSmall = f => { const st = lstatSync(f); return st.isFile() && st.size < 1e6 ? readFileSync(f, 'utf8') : null }

export const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')

// USD per million tokens, first-party API list prices. Edit here when prices change.
// [model id pattern, input, output, cache read, known, [input, output, cache read] above 100k prompt tokens]
// Most specific id first; the bare family rows are fallbacks and the report calls them "estimated".
// Cache write is priced from the input rate: 1.25x for the 5 minute tier, 2x for the 1 hour tier.
export const PRICES_AS_OF = '2026-10-06'
export const PRICES = [
  [/opus-5-5/, 4, 20, 0.2, true],
  [/opus-(5|4-[678])/, 5, 25, 0.5, true],
  [/opus/, 5, 25, 0.5, false],
  [/fable-5-1/, 10, 50, 0.25, true],
  [/fable|mythos/, 10, 50, 1, false],
  [/sonnet-5/, 2, 10, 0.2, true],
  [/sonnet-4-6/, 3, 15, 0.3, true],
  [/sonnet/, 3, 15, 0.3, false],
  [/haiku-5-5/, 0.1, 0.5, 0.01, true, [0.5, 2.5, 0.05]],
  [/haiku-4-5/, 1, 5, 0.1, true],
  [/haiku/, 1, 5, 0.1, false],
]
export function price(model, promptTokens = 0) {
  const hit = PRICES.find(([re]) => re.test(model || ''))
  if (!hit) return { inp: 3, out: 15, cr: 0.3, known: false }
  const [, inp, out, cr, known, big] = hit
  return big && promptTokens > 100_000 ? { inp: big[0], out: big[1], cr: big[2], known } : { inp, out, cr, known }
}
// u.cw is all cache-write tokens; u.cw1 the part written at the 1 hour tier. Without a split, all count as 5 minute.
export function cost(u, model) {
  const p = price(model, u.input + u.cw + u.cr)
  const cw1 = u.cw1 || 0
  return (u.input * p.inp + u.out * p.out + (u.cw - cw1) * p.inp * 1.25 + cw1 * p.inp * 2 + u.cr * p.cr) / 1e6
}

function* walk(dir, depth = 6) {
  let ents
  try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of ents) {
    const p = join(dir, e.name)
    if (e.isDirectory() && depth > 0 && e.name !== 'node_modules') yield* walk(p, depth - 1)
    else if (e.isFile()) yield p
  }
}

async function readTurns(file, since, into) {
  const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity })
  for await (const line of rl) {
    if (!line.includes('"usage"')) continue
    let o
    try { o = JSON.parse(line) } catch { continue }
    const m = o.message
    if (o.type !== 'assistant' || !m?.usage) continue
    const t = Date.parse(o.timestamp)
    if (t < since) continue
    // A turn is logged once per content block; the last copy holds the final usage.
    into.set(m.id ?? o.uuid, { t, model: m.model, cwd: o.cwd, u: { input: m.usage.input_tokens || 0, out: m.usage.output_tokens || 0, cw: m.usage.cache_creation_input_tokens || 0, cr: m.usage.cache_read_input_tokens || 0, cw1: m.usage.cache_creation?.ephemeral_1h_input_tokens || 0 } })
  }
}

const add = (a, b) => { for (const k of ['input', 'out', 'cw', 'cr', 'usd', 'turns']) a[k] = (a[k] || 0) + (b[k] || 0); return a }
const n = x => (x >= 1e6 ? (x / 1e6).toFixed(2) + 'M' : x >= 1e3 ? (x / 1e3).toFixed(1) + 'k' : String(x))
const row = (label, a) => `${label.padEnd(34).slice(0, 34)} ${n(a.input).padStart(7)} ${n(a.out).padStart(7)} ${n(a.cw).padStart(7)} ${n(a.cr).padStart(8)} ${('$' + a.usd.toFixed(2)).padStart(9)}`
const head = label => `${label.padEnd(34)} ${'input'.padStart(7)} ${'output'.padStart(7)} ${'c.write'.padStart(7)} ${'c.read'.padStart(8)} ${'est.cost'.padStart(9)}`

export async function usage(days, now = Date.now(), dir = claudeDir()) {
  const since = now - days * 864e5
  const root = join(dir, 'projects')
  if (!existsSync(root)) return `No transcripts under ${root}.`
  const sessions = new Map(), projects = new Map(), models = new Map()
  const estimated = new Set()
  for (const proj of readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory())) {
    const pdir = join(root, proj.name)
    for (const file of [...walk(pdir, 3)].filter(f => f.endsWith('.jsonl'))) {
      if (statSync(file).mtimeMs < since) continue
      const turns = new Map()
      await readTurns(file, since, turns)
      // sessionId/subagents/agent.jsonl counts toward its session
      const rel = file.slice(pdir.length + 1).split(/[\\/]/)
      const sid = rel[0].replace(/\.jsonl$/, '')
      for (const { t, model, cwd, u } of turns.values()) {
        if (!u.input && !u.out && !u.cw && !u.cr) continue
        const usd = cost(u, model)
        if (!price(model, u.input + u.cw + u.cr).known) estimated.add(model || 'unknown')
        const rec = { ...u, usd, turns: 1 }
        const s = sessions.get(sid) || { label: '', last: 0 }
        s.label = s.label || cwd || proj.name
        s.last = Math.max(s.last, t)
        sessions.set(sid, add(s, rec))
        const p = projects.get(proj.name) || { label: cwd || proj.name }
        projects.set(proj.name, add(p, rec))
        models.set(model || 'unknown', add(models.get(model || 'unknown') || {}, rec))
      }
    }
  }
  const total = [...projects.values()].reduce(add, {})
  if (!total.turns) return `No usage in the last ${days} days.`
  const top = (m, k) => [...m.entries()].sort((a, b) => b[1].usd - a[1].usd).slice(0, k)
  return [
    `Token usage, last ${days} days. Estimates at list prices as of ${PRICES_AS_OF}; cache writes priced by tier (5 minute 1.25x, 1 hour 2x input).`,
    '', head('TOTAL'), row(`${total.turns} turns`, total),
    '', head('BY PROJECT'), ...top(projects, 10).map(([, p]) => row(p.label.split(/[\\/]/).slice(-2).join('/'), p)),
    '', head('BY MODEL'), ...top(models, 10).map(([m, a]) => row(m, a)),
    '', head('TOP SESSIONS'), ...top(sessions, 10).map(([id, s]) => row(`${id.slice(0, 8)} ${new Date(s.last).toISOString().slice(0, 10)} ${s.label.split(/[\\/]/).pop()}`, s)),
    ...(estimated.size ? ['', `Estimated (no exact price row, family or Sonnet rate used): ${[...estimated].join(', ')}. Edit PRICES in hooks/scan.mjs.`] : []),
  ].map(strip).join('\n')
}

// ---- audit ----

const tok = chars => Math.round(chars / 4)
function description(file) {
  let t
  try { t = readSmall(file) } catch { return '' }
  if (t === null) return ''
  const m = t.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return ''
  const lines = m[1].split(/\r?\n/)
  const i = lines.findIndex(l => /^description:/.test(l))
  if (i < 0) return ''
  const out = [lines[i].replace(/^description:\s*[>|]?-?\s*/, '')]
  for (const l of lines.slice(i + 1)) { if (/^[\w-]+:/.test(l)) break; out.push(l.trim()) }
  return out.join(' ').trim()
}

function claudeMdChain(cwd, dir) {
  const files = [join(dir, 'CLAUDE.md')]
  for (let d = resolve(cwd); ; d = dirname(d)) {
    files.push(...[join(d, 'CLAUDE.md'), join(d, '.claude', 'CLAUDE.md')].filter(f => plain(d, f)))
    if (dirname(d) === d) break
  }
  const seen = new Set()
  return [...new Set(files)].flatMap(f => {
    let text
    try { text = readSmall(f) } catch { return [] }
    if (text === null) return []
    // One level of @imports: regular files under 1 MB, each counted once, 100 at most, never a network path.
    let imp = 0
    for (const m of text.matchAll(/^@(\S+)/gm)) {
      if (seen.size >= 100 || /^[\\/]{2}/.test(m[1])) continue
      const p = resolve(dirname(f), m[1])
      if (seen.has(p) || !plain(dirname(f), p)) continue
      seen.add(p)
      try { imp += readSmall(p)?.length ?? 0 } catch { /* none */ }
    }
    return [{ file: f, chars: text.length + imp }]
  })
}

function installedPlugins(dir) {
  try {
    const j = JSON.parse(readFileSync(join(dir, 'plugins', 'installed_plugins.json'), 'utf8'))
    // Ids look like name@market; anything else (control characters included) is ignored.
    return Object.entries(j.plugins || {}).filter(([id]) => /^[\w.@-]+$/.test(id)).flatMap(([id, v]) => (Array.isArray(v) ? v : [v]).slice(0, 1).map(x => ({ id, path: x?.installPath, at: Date.parse(x?.installedAt || x?.lastUpdated) || 0 })).filter(x => typeof x.path === 'string' && x.path))
  } catch { return [] }
}

const norm = s => s.toLowerCase().replace(/(plugin|mcp|server|claude|ai)/g, '').replace(/[^a-z0-9]/g, '')
const safeHost = u => { try { return new URL(u).host } catch { return 'url' } }

function mcpServers(cwd, dir, plugins) {
  const out = []
  // `sig` is printed: the URL host or the command name. `key` also holds the first plain argument, which can be a
  // token, so it only matches duplicates and is never printed.
  const take = (src, obj) => Object.entries(obj || {}).forEach(([name, c]) => {
    const sig = c.url ? safeHost(c.url) : basename(String(c.command || ''))
    out.push({ src, name, sig, key: c.url ? sig : `${sig} ${(c.args || []).filter(a => !/^-/.test(a)).slice(0, 1).join(' ')}` })
  })
  try { const j = JSON.parse(readFileSync(process.env.CLAUDE_CONFIG_DIR ? join(dir, '.claude.json') : join(homedir(), '.claude.json'), 'utf8')); take('user', j.mcpServers); take('project', (j.projects?.[cwd] ?? j.projects?.[cwd.replace(/\\/g, '/')])?.mcpServers) } catch { /* none */ }
  try { take('.mcp.json', JSON.parse(readSmall(join(cwd, '.mcp.json'))).mcpServers) } catch { /* none */ }
  for (const p of plugins) {
    try { const j = JSON.parse(readSmall(join(p.path, '.mcp.json'))); take(p.id, j.mcpServers || j) } catch { /* none */ }
  }
  return out
}

export function audit(cwd, dir = claudeDir()) {
  const plugins = installedPlugins(dir)
  const own = n => [join(cwd, '.claude', n)].filter(r => plain(cwd, r))
  const roots = [join(dir, 'skills'), ...own('skills'), ...plugins.map(p => join(p.path, 'skills'))]
  const skills = roots.flatMap(r => [...walk(r, 3)].filter(f => basename(f) === 'SKILL.md').map(f => ({ name: basename(dirname(f)), chars: description(f).length })))
  const agentFiles = [join(dir, 'agents'), ...own('agents'), ...plugins.map(p => join(p.path, 'agents'))].flatMap(r => [...walk(r, 2)].filter(f => f.endsWith('.md')))
  const agents = agentFiles.map(f => ({ name: basename(f, '.md'), chars: description(f).length }))
  const md = claudeMdChain(cwd, dir)
  const mcp = mcpServers(cwd, dir, plugins)
  const sum = xs => xs.reduce((s, x) => s + x.chars, 0)
  const longest = xs => [...xs].sort((a, b) => b.chars - a.chars).slice(0, 5).map(x => `  ${cap(x.name)} (${x.chars} chars)`).join('\n')
  const tips = []
  const mdTotal = sum(md)
  if (mdTotal > 12_000) tips.push(`CLAUDE.md files total about ${tok(mdTotal)} tokens and load every session. Move rarely used detail into files read on demand.`)
  const names = new Map()
  for (const s of skills) names.set(s.name, (names.get(s.name) || 0) + 1)
  const dupSkills = [...names].filter(([, c]) => c > 1).map(([k]) => k)
  if (dupSkills.length) tips.push(`Skills defined more than once: ${dupSkills.slice(0, 8).join(', ')}. Keep one copy.`)
  if (sum(skills) + sum(agents) > 30_000) tips.push(`Skill and agent descriptions total about ${tok(sum(skills) + sum(agents))} tokens. Shorten the longest ones or disable plugins you do not use.`)
  const groups = new Map()
  for (const m of mcp) groups.set(norm(m.name) || m.name, [...(groups.get(norm(m.name) || m.name) || []), m])
  for (const [, g] of groups) if (g.length > 1) tips.push(`MCP server loaded more than once: ${g.map(m => `${m.name} (${m.src})`).join(' and ')}. Keep one.`)
  const bySig = new Map()
  for (const m of mcp) bySig.set(m.key, [...(bySig.get(m.key) || []), m])
  for (const [key, g] of bySig) if (g.length > 1 && key.trim() && new Set(g.map(m => norm(m.name))).size > 1) tips.push(`MCP servers share the same target (${cap(g[0].sig)}): ${g.map(m => cap(m.name)).join(', ')}.`)
  if (!tips.length) tips.push('Nothing stands out.')
  return [
    'Setup audit (read only; nothing was changed)',
    '',
    `CLAUDE.md: ${md.length} file(s), about ${tok(mdTotal)} tokens`, ...md.map(m => `  ${m.file} (${m.chars} chars)`),
    `Skills: ${skills.length}, descriptions about ${tok(sum(skills))} tokens. Longest:`, longest(skills),
    `Agents: ${agents.length}, descriptions about ${tok(sum(agents))} tokens. Longest:`, longest(agents),
    `MCP servers on disk: ${mcp.length}`, ...mcp.map(m => `  ${cap(m.name)} [${m.src}] ${cap(m.sig)}`),
    '  Tool counts need a live connection. Run /context to see them. Account-level connectors (for example Notion from claude.ai) are not on disk and are not listed.',
    '',
    'Suggestions (each is a change for you to approve and make):',
    ...tips.map(t => `- ${t}`),
  ].map(strip).join('\n')
}

// ---- plan: what to turn off, learned from how the person really uses Claude ----

// Every skill, command, subagent type and MCP server the person or the model used in the window.
async function signals(days, now, dir) {
  const since = now - days * 864e5
  const sig = new Set()
  let sessions = 0, compactions = 0
  const root = join(dir, 'projects')
  if (!existsSync(root)) return { sig, sessions, compactions }
  for (const proj of readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory())) {
    const pdir = join(root, proj.name)
    for (const file of [...walk(pdir, 3)].filter(f => f.endsWith('.jsonl'))) {
      if (statSync(file).mtimeMs < since) continue
      if (file.slice(pdir.length + 1).split(/[\\/]/).length === 1) sessions++
      const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity })
      for await (const line of rl) {
        if (line.includes('compact_boundary') && !(Date.parse(line.match(/"timestamp":"([^"]+)"/)?.[1]) < since)) compactions++
        for (const m of line.matchAll(/<command-name>\/?([^<]+)<\/command-name>/g)) sig.add('cmd:' + m[1].trim().toLowerCase())
        if (!line.includes('"tool_use"')) continue
        let o
        try { o = JSON.parse(line) } catch { continue }
        if (Date.parse(o.timestamp) < since || !Array.isArray(o.message?.content)) continue
        for (const b of o.message.content) {
          if (b.type !== 'tool_use') continue
          const name = String(b.name || '')
          if (name === 'Skill' && b.input?.skill) sig.add('skill:' + String(b.input.skill).toLowerCase())
          else if ((name === 'Agent' || name === 'Task') && b.input?.subagent_type) sig.add('agent:' + String(b.input.subagent_type).toLowerCase())
          else if (name.startsWith('mcp__')) sig.add('mcp:' + name.split('__')[1].toLowerCase())
        }
      }
    }
  }
  return { sig, sessions, compactions }
}

const NOT_PURE = ['hooks', 'lspServers', 'outputStyles', 'monitors', 'themes']
const names = (dir, test) => [...walk(dir, 3)].filter(test)

// Enabled plugins that only add skills, commands, agents or MCP servers, were installed long enough ago,
// and left no trace in the window. A plugin with hooks or other behaviour is never listed.
export function unusedPlugins(dir, enabled, sig, now, minAgeDays = 30) {
  const out = []
  for (const p of installedPlugins(dir)) {
    const plugin = p.id.split('@')[0].toLowerCase()
    if (enabled[p.id] !== true || plugin === 'token-lens') continue
    if (!existsSync(p.path) || (now - (p.at || statSync(p.path).birthtimeMs)) / 864e5 < minAgeDays) continue
    let manifest = {}
    try { manifest = JSON.parse(readFileSync(join(p.path, '.claude-plugin', 'plugin.json'), 'utf8')) } catch { /* none */ }
    if (NOT_PURE.some(k => k in manifest) || existsSync(join(p.path, 'hooks'))) continue
    const skills = names(join(p.path, 'skills'), f => basename(f) === 'SKILL.md')
    const cmds = names(join(p.path, 'commands'), f => f.endsWith('.md')).map(f => basename(f, '.md').toLowerCase())
    const agents = names(join(p.path, 'agents'), f => f.endsWith('.md')).map(f => basename(f, '.md').toLowerCase())
    let servers = []
    try { const j = JSON.parse(readFileSync(join(p.path, '.mcp.json'), 'utf8')); servers = Object.keys(j.mcpServers || j).map(k => k.toLowerCase()) } catch { /* none */ }
    if ('mcpServers' in manifest) servers.push(...Object.keys(manifest.mcpServers || {}).map(k => k.toLowerCase()))
    const skillNames = skills.map(f => basename(dirname(f)).toLowerCase())
    if (!skillNames.length && !cmds.length && !agents.length && !servers.length) continue
    const has = x => sig.has(x)
    const used = [...skillNames, ...cmds].some(n => has(`skill:${n}`) || has(`skill:${plugin}:${n}`) || has(`cmd:${n}`) || has(`cmd:${plugin}:${n}`))
      || agents.some(n => has(`agent:${n}`) || has(`agent:${plugin}:${n}`))
      || servers.some(n => has(`mcp:${n}`) || has(`mcp:plugin_${plugin}_${n}`))
      || [...sig].some(x => x.startsWith(`skill:${plugin}:`) || x.startsWith(`cmd:${plugin}:`) || x.startsWith(`agent:${plugin}:`) || x.startsWith(`mcp:plugin_${plugin}_`))
    if (used) continue
    const tokens = tok([...skills].reduce((s, f) => s + description(f).length, 0) + names(join(p.path, 'agents'), f => f.endsWith('.md')).reduce((s, f) => s + description(f).length, 0))
    out.push({ id: p.id, tokens, skills: skillNames.length, agents: agents.length, servers: servers.length })
  }
  return out.sort((a, b) => b.tokens - a.tokens)
}

export async function plan(days = 30, now = Date.now(), dir = claudeDir()) {
  const { sig, sessions, compactions } = await signals(days, now, dir)
  const settingsPath = join(dir, 'settings.json')
  let enabled = {}
  try { enabled = JSON.parse(readFileSync(settingsPath, 'utf8')).enabledPlugins || {} } catch { /* none */ }
  // Too little history means "unused" proves nothing.
  const candidates = sessions >= 15 ? unusedPlugins(dir, enabled, sig, now) : []
  return { days, sessions, compactions, settingsPath, candidates }
}

// ---- sessions: one pass over the transcripts feeds trends, drift, coach, route, quick and the dashboard ----

export const dataDir = (dir = claudeDir()) => join(dir, 'token-lens')
const zero = () => ({ input: 0, out: 0, cw: 0, cr: 0, usd: 0, turns: 0 })
const promptText = c => (typeof c === 'string' ? c : Array.isArray(c) && !c.some(b => b?.type === 'tool_result') ? c.filter(b => b?.type === 'text').map(b => b.text).join('\n') : '')
// A repeat Read that token-lens withheld is stored as an error result; it is not a real failure.
const resultText = r => (typeof r.content === 'string' ? r.content : Array.isArray(r.content) ? r.content.map(b => b?.text ?? '').join('') : '')
const resultLen = r => (typeof r.content === 'string' ? r.content.length : Array.isArray(r.content) ? r.content.reduce((s, b) => s + (b?.text?.length ?? (b?.type === 'image' ? 6000 : 0)), 0) : 0)

async function readSession(file, since, s, sub) {
  const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity })
  const results = new Map()
  for await (const line of rl) {
    if (!sub && line.includes('compact_boundary') && !(Date.parse(line.match(/"timestamp":"([^"]+)"/)?.[1]) < since)) s.compactions++
    if (!line.includes('"type":"assistant"') && !line.includes('"type":"user"')) continue
    let o
    try { o = JSON.parse(line) } catch { continue }
    const t = Date.parse(o.timestamp)
    if (!(t >= since)) continue
    s.start = Math.min(s.start, t)
    s.end = Math.max(s.end, t)
    if (o.cwd) s.label = o.cwd
    const m = o.message
    if (o.type === 'assistant' && m) {
      const id = m.id ?? o.uuid
      const rec = s.turns.get(id) ?? { t, model: m.model, sub, tools: [], text: 0, think: 0, u: null }
      if (m.usage) rec.u = { input: m.usage.input_tokens || 0, out: m.usage.output_tokens || 0, cw: m.usage.cache_creation_input_tokens || 0, cr: m.usage.cache_read_input_tokens || 0, cw1: m.usage.cache_creation?.ephemeral_1h_input_tokens || 0 }
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b.type === 'text') rec.text += b.text?.length ?? 0
        else if (b.type === 'thinking') rec.think += b.thinking?.length ?? 0
        else if (b.type === 'tool_use') {
          const use = { id: b.id, name: String(b.name || ''), key: `${b.name}:${JSON.stringify(b.input ?? {}).slice(0, 400)}`, path: String(b.input?.file_path ?? ''), t, sub, err: false, len: 0 }
          rec.tools.push(use)
          s.tools.push(use)
        }
      }
      s.turns.set(id, rec)
      if (!sub && m.model && m.model !== '<synthetic>' && s.models.at(-1) !== m.model) s.models.push(m.model)
    } else if (o.type === 'user' && m) {
      for (const b of Array.isArray(m.content) ? m.content : []) if (b?.type === 'tool_result') results.set(b.tool_use_id, { err: b.is_error === true && !resultText(b).includes('[token-lens'), len: resultLen(b) })
      const p = sub || o.isMeta ? '' : promptText(m.content)
      if (p.trim() && !p.trimStart().startsWith('<')) s.prompts.push({ t, text: p.slice(0, 2000), words: p.split(/\s+/).filter(Boolean).length })
    }
  }
  for (const u of s.tools) if (results.has(u.id)) Object.assign(u, results.get(u.id))
}

export async function collect(days, now = Date.now(), dir = claudeDir()) {
  const since = now - days * 864e5
  const root = join(dir, 'projects')
  if (!existsSync(root)) return []
  const all = new Map()
  for (const proj of readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory())) {
    const pdir = join(root, proj.name)
    for (const file of [...walk(pdir, 3)].filter(f => f.endsWith('.jsonl'))) {
      if (statSync(file).mtimeMs < since) continue
      const rel = file.slice(pdir.length + 1).split(/[\\/]/)
      const sid = rel[0].replace(/\.jsonl$/, '')
      const s = all.get(sid) ?? { sid, label: proj.name, start: Infinity, end: 0, turns: new Map(), compactions: 0, prompts: [], tools: [], models: [] }
      all.set(sid, s)
      await readSession(file, since, s, rel.length > 1)
    }
  }
  return [...all.values()].map(s => {
    const turns = [...s.turns.values()].filter(r => r.u && (r.u.input || r.u.out || r.u.cw || r.u.cr))
    for (const r of turns) r.usd = cost(r.u, r.model)
    const total = turns.reduce((a, r) => add(a, { ...r.u, usd: r.usd, turns: 1 }), zero())
    return { ...s, turns, total, hours: (s.end - s.start) / 36e5 }
  }).filter(s => s.turns.length)
}

const hit = a => (a.input + a.cw + a.cr ? a.cr / (a.input + a.cw + a.cr) : 0)
const pct = x => `${Math.round(x * 100)}%`
const usd = x => `$${x.toFixed(2)}`
const day = t => new Date(t).toISOString().slice(0, 10)

export async function trends(days, now = Date.now(), dir = claudeDir()) {
  const sessions = await collect(days, now, dir)
  const byDay = new Map()
  for (const s of sessions) for (const r of s.turns) byDay.set(day(r.t), add(byDay.get(day(r.t)) || zero(), { ...r.u, usd: r.usd, turns: 1 }))
  if (!byDay.size) return `No usage in the last ${days} days.`
  const rows = [...byDay].sort((a, b) => a[0].localeCompare(b[0]))
  const top = Math.max(...rows.map(([, a]) => a.usd), 0.01)
  return [`Daily trend, last ${days} days (estimated cost at list prices as of ${PRICES_AS_OF}).`, '', `${'date'.padEnd(10)} ${'turns'.padStart(6)} ${'tokens'.padStart(8)} ${'cache hit'.padStart(9)} ${'cost'.padStart(9)}`,
    ...rows.map(([d, a]) => `${d} ${String(a.turns).padStart(6)} ${n(a.input + a.out + a.cw + a.cr).padStart(8)} ${pct(hit(a)).padStart(9)} ${usd(a.usd).padStart(9)} ${'#'.repeat(Math.round((a.usd / top) * 30))}`)].join('\n')
}

// Week over week, per session: what moved.
export async function drift(now = Date.now(), dir = claudeDir()) {
  const sessions = await collect(14, now, dir)
  const weeks = [sessions.filter(s => s.end >= now - 7 * 864e5), sessions.filter(s => s.end < now - 7 * 864e5)]
  const q = qualityFiles(14, now, dir)
  const stats = (ss, from, to) => {
    const t = ss.reduce((a, s) => add(a, s.total), zero())
    const k = Math.max(1, ss.length)
    const qs = q.filter(x => x.at >= from && x.at < to).map(x => x.score)
    return { n: ss.length, usd: t.usd / k, turns: t.turns / k, hit: hit(t), comp: ss.reduce((a, s) => a + s.compactions, 0) / k, hours: ss.reduce((a, s) => a + s.hours, 0) / k, quality: qs.length ? qs.reduce((a, b) => a + b, 0) / qs.length : null }
  }
  const [w, p] = [stats(weeks[0], now - 7 * 864e5, now + 1), stats(weeks[1], now - 14 * 864e5, now - 7 * 864e5)]
  if (!w.n && !p.n) return 'No sessions in the last 14 days.'
  const move = (a, b, fmt, goodUp) => `${fmt(b)} -> ${fmt(a)}${b && fmt(a) !== fmt(b) ? ` (${a > b === goodUp ? 'better' : 'worse'})` : ''}`
  return ['Drift: this week against the week before, per session.', '',
    `Sessions:            ${p.n} -> ${w.n}`,
    `Cost per session:    ${move(w.usd, p.usd, usd, false)}`,
    `Turns per session:   ${move(w.turns, p.turns, x => x.toFixed(0), false)}`,
    `Hours per session:   ${move(w.hours, p.hours, x => x.toFixed(1), false)}`,
    `Cache hit rate:      ${move(w.hit, p.hit, pct, true)}`,
    `Compactions/session: ${move(w.comp, p.comp, x => x.toFixed(2), false)}`,
    `Quality (token-lens): ${w.quality === null || p.quality === null ? 'not enough graded sessions yet' : move(w.quality, p.quality, x => x.toFixed(0), true)}`].join('\n')
}

// Quality files token-lens wrote for each session (score, grade, start, update), newest first.
export function qualityFiles(days, now = Date.now(), dir = claudeDir()) {
  const d = dataDir(dir)
  let names = []
  try { names = readdirSync(d).filter(f => /^quality-[\w-]+\.json$/.test(f)) } catch { return [] }
  return names.flatMap(f => {
    try {
      const st = statSync(join(d, f))
      if (now - st.mtimeMs > days * 864e5) return []
      const j = JSON.parse(readFileSync(join(d, f), 'utf8'))
      return typeof j.score === 'number' ? [{ sid: f.slice(8, -5), at: st.mtimeMs, score: j.score, grade: String(j.grade || ''), start: (j.session_start_ts || 0) * 1000 }] : []
    } catch { return [] }
  }).sort((a, b) => b.at - a.at)
}

const words = s => new Set(s.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? [])
const similar = (a, b) => { const x = words(a), y = words(b); let c = 0; for (const w of x) if (y.has(w)) c++; return x.size && y.size ? c / (x.size + y.size - c) : 0 }
const BIG_MODEL = /opus|fable/i
const SMALL_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'Read', 'Glob', 'Grep'])
const small = r => r.u.out < 300 && r.tools.every(u => SMALL_TOOLS.has(u.name))

// Each finding: what it is, the numbers behind it, and what to do. Ranked by estimated tokens or cost.
export function findings(sessions, q = []) {
  const out = []
  const push = (weight, title, detail, fix) => out.push({ weight, title, detail, fix })
  const tools = sessions.flatMap(s => s.tools)
  const files = tools.filter(u => u.name === 'Read' && /\.(pdf|png|jpe?g|gif|webp|zip|docx?|xlsx?)$/i.test(u.path))
  if (files.length) push(files.reduce((a, u) => a + u.len, 0) / 4, 'PDF and binary ingestion', `${files.length} reads of PDFs, images or office files, about ${n(Math.round(files.reduce((a, u) => a + u.len, 0) / 4))} tokens.`, 'Read only the pages you need (the Read tool takes a page range), or convert to text once.')
  const web = tools.filter(u => u.name === 'WebSearch' || u.name === 'WebFetch')
  const webTok = web.reduce((a, u) => a + u.len, 0) / 4
  if (webTok > 20_000) push(webTok, 'Web search overhead', `${web.length} web calls brought in about ${n(Math.round(webTok))} tokens.`, 'Ask for one focused search, or use a subagent so the raw pages stay out of the main context.')
  let churn = 0, cascades = 0
  for (const s of sessions) {
    const errs = new Map()
    for (const u of s.tools) if (u.err) errs.set(u.key, (errs.get(u.key) || 0) + 1)
    churn += [...errs.values()].filter(c => c >= 3).length
    let run = 0
    for (const u of s.tools.filter(x => !x.sub)) { run = u.err ? run + 1 : 0; if (run === 3) cascades++ }
  }
  if (churn) push(churn * 3000, 'Retry churn', `${churn} times the same tool call failed 3 or more times in one session.`, 'When a call fails twice, stop and read the error; change the call before retrying.')
  if (cascades) push(cascades * 3000, 'Tool cascades', `${cascades} runs of 3 or more failed tool calls in a row.`, 'Turn on the loop nudge (/tokens nudge loop on) to get a reminder in the session.')
  let loops = 0
  for (const s of sessions) for (let i = 1; i < s.prompts.length; i++) if (similar(s.prompts[i].text, s.prompts[i - 1].text) >= 0.7) loops++
  if (loops >= 3) push(loops * 2000, 'Looping prompts', `${loops} prompts were close copies of the prompt before them.`, 'If an approach fails twice, describe what went wrong instead of asking again.')
  const big = sessions.flatMap(s => s.turns.filter(r => !r.sub && BIG_MODEL.test(r.model || '') && small(r)))
  const bigUsd = big.reduce((a, r) => a + r.usd, 0)
  const asSonnet = big.reduce((a, r) => a + cost(r.u, 'claude-sonnet-5-5'), 0)
  const bigAll = sessions.flatMap(s => s.turns.filter(r => !r.sub && BIG_MODEL.test(r.model || '')))
  if (big.length >= 20 && big.length / bigAll.length >= 0.3) push((bigUsd - asSonnet) * 1e5, 'Overpowered model', `${big.length} small turns (under 300 output tokens, edits or reads only) ran on Opus or Fable: ${usd(bigUsd)}; on Sonnet about ${usd(asSonnet)}.`, 'Use /model sonnet for mechanical edits; /tokens route has the detail.')
  const weak = sessions.filter(s => s.turns.filter(r => !r.sub).length >= 40 && s.turns.filter(r => !r.sub).every(r => /haiku/i.test(r.model || '')))
  if (weak.length) push(weak.length * 5000, 'Weak model on long tasks', `${weak.length} long sessions (40+ turns) ran on Haiku only.`, 'Long, multi-step work is often cheaper on Sonnet: fewer retries.')
  const longPrompts = sessions.flatMap(s => s.prompts.filter(p => p.words > 500))
  if (longPrompts.length >= 3) push(longPrompts.length * 1500, 'Monolithic prompts', `${longPrompts.length} prompts over 500 words.`, 'Split big requests into steps, or put the spec in a file and point to it.')
  const thinky = sessions.flatMap(s => s.turns.filter(r => r.think > 2 * (r.text + 200) && r.tools.length && r.tools.every(u => u.name === 'Edit')))
  if (thinky.length >= 10) push(thinky.reduce((a, r) => a + r.think, 0) / 4, 'Wasteful thinking', `${thinky.length} single-edit turns thought more than twice as much as they wrote.`, 'Use /effort low for simple edits.')
  const verbose = sessions.flatMap(s => s.turns.filter(r => !r.sub && r.text > 3000 && !r.tools.length && r.u.out > 1000))
  if (verbose.length >= 10) push(verbose.reduce((a, r) => a + r.u.out, 0) / 2, 'Long answers', `${verbose.length} answers over 3,000 characters with no tool use.`, 'Ask for short answers, or turn on the lean nudge (/tokens nudge lean on).')
  const rewrites = sessions.flatMap(s => s.turns.filter(r => !r.sub).slice(3).filter(r => r.u.cw > 20_000 && r.u.cw > r.u.cr))
  if (rewrites.length >= 5) push(rewrites.reduce((a, r) => a + r.u.cw, 0) * 0.25, 'Cache instability', `${rewrites.length} turns, after the first few of a session, rewrote more of the cache than they read (${n(rewrites.reduce((a, r) => a + r.u.cw, 0))} tokens written).`, 'Long pauses (cache expiry), model switches and edits to CLAUDE.md or MCP settings mid-session all force a rewrite.')
  const switchy = sessions.filter(s => s.models.length >= 4)
  if (switchy.length) push(switchy.length * 4000, 'Model switching', `${switchy.length} sessions switched model 3 or more times. Each switch starts a new prompt cache.`, 'Pick the model at the start of a session and keep it.')
  if (q.length >= 6) {
    const bad = q.filter(x => /^[DF]$/.test(x.grade)).length
    if (bad / q.length >= 0.25) push(bad * 5000, 'Low grades', `${bad} of ${q.length} graded sessions ended at D or F.`, 'Compact or start fresh sooner; /tokens quality shows what drags a live session down.')
    const dur = q.filter(x => x.start).map(x => ({ h: (x.at - x.start) / 36e5, s: x.score }))
    const short = dur.filter(x => x.h < 1), long = dur.filter(x => x.h >= 3)
    const avg = xs => xs.reduce((a, x) => a + x.s, 0) / xs.length
    if (short.length >= 3 && long.length >= 3 && avg(short) - avg(long) >= 8) push(6000, 'Long sessions score lower', `Sessions under 1 hour average ${avg(short).toFixed(0)}; sessions over 3 hours average ${avg(long).toFixed(0)}.`, 'Break long work into sessions; /tokens checkpoint and restore carry the context over.')
  }
  return out.sort((a, b) => b.weight - a.weight)
}

export async function coach(days, now = Date.now(), dir = claudeDir()) {
  const sessions = await collect(days, now, dir)
  if (!sessions.length) return `No sessions in the last ${days} days.`
  const half = now - (days / 2) * 864e5
  const [late, early] = [sessions.filter(s => s.end >= half), sessions.filter(s => s.end < half)]
  const per = ss => ss.reduce((a, s) => add(a, s.total), zero())
  const trend = []
  if (late.length >= 3 && early.length >= 3) {
    const [a, b] = [per(late), per(early)]
    if (a.usd / late.length > 1.25 * (b.usd / early.length)) trend.push(`Cost per session is climbing: ${usd(b.usd / early.length)} -> ${usd(a.usd / late.length)} (first half of the window against the second).`)
    if (hit(a) < hit(b) - 0.05) trend.push(`Cache hit rate is falling: ${pct(hit(b))} -> ${pct(hit(a))}.`)
    const hrs = ss => ss.reduce((x, s) => x + s.hours, 0) / ss.length
    if (hrs(late) > 1.3 * hrs(early)) trend.push(`Sessions are getting longer: ${hrs(early).toFixed(1)} h -> ${hrs(late).toFixed(1)} h on average.`)
  }
  const f = findings(sessions, qualityFiles(days, now, dir))
  return [`Coach: ${sessions.length} sessions, last ${days} days. Each item is a suggestion for you to act on; token-lens changes nothing here.`, '',
    ...(trend.length ? ['Trends:', ...trend.map(t => `- ${t}`), ''] : []),
    ...(f.length ? f.slice(0, 10).flatMap((x, i) => [`${i + 1}. ${x.title}: ${x.detail}`, `   Fix: ${x.fix}`]) : ['No waste pattern stands out.'])].join('\n')
}

export async function route(days, now = Date.now(), dir = claudeDir()) {
  const turns = (await collect(days, now, dir)).flatMap(s => s.turns.filter(r => !r.sub))
  if (!turns.length) return `No turns in the last ${days} days.`
  const models = new Map()
  for (const r of turns) models.set(r.model || 'unknown', [...(models.get(r.model || 'unknown') || []), r])
  const lines = [...models].sort((a, b) => b[1].length - a[1].length).map(([m, rs]) => {
    const sm = rs.filter(small)
    const spent = sm.reduce((a, r) => a + r.usd, 0)
    const alt = BIG_MODEL.test(m) ? sm.reduce((a, r) => a + cost(r.u, 'claude-sonnet-5-5'), 0) : null
    return `- ${m}: ${rs.length} turns, ${sm.length} small (${pct(sm.length / rs.length)}), ${usd(spent)} on small turns${alt !== null && sm.length ? `; on Sonnet about ${usd(alt)}` : ''}`
  })
  const big = turns.filter(r => BIG_MODEL.test(r.model || ''))
  const share = big.length ? big.filter(small).length / big.length : 0
  return [`Model routing, last ${days} days, main conversation only. A small turn has under 300 output tokens and uses only edit, read and search tools.`, '', ...lines, '',
    share >= 0.3 ? `Advice: ${pct(share)} of Opus and Fable turns were small. Use /model sonnet for mechanical edits and keep the big model for design and debugging. /effort low also cuts thinking on simple edits.` : 'Advice: model use looks matched to the work.',
    'Effort levels are not stored in transcripts, so they are not measured here.'].join('\n')
}

// The current session, cost per prompt: which requests were expensive.
export async function conversation(sid, dir = claudeDir()) {
  const root = join(dir, 'projects')
  const s = { sid, label: '', start: Infinity, end: 0, turns: new Map(), compactions: 0, prompts: [], tools: [], models: [] }
  let found = false
  for (const proj of existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()) : []) {
    const main = join(root, proj.name, `${sid}.jsonl`)
    if (!/^[\w-]+$/.test(sid) || !existsSync(main)) continue
    found = true
    await readSession(main, 0, s, false)
    for (const f of [...walk(join(root, proj.name, sid), 2)].filter(x => x.endsWith('.jsonl'))) await readSession(f, 0, s, true)
  }
  if (!found) return 'This session has no transcript yet.'
  const turns = [...s.turns.values()].filter(r => r.u).sort((a, b) => a.t - b.t)
  const groups = s.prompts.map((p, i) => ({ p, from: p.t, to: s.prompts[i + 1]?.t ?? Infinity, a: zero(), sub: 0 }))
  for (const r of turns) {
    const g = groups.findLast(x => x.from <= r.t) ?? groups[0]
    if (!g) continue
    const c = cost(r.u, r.model)
    add(g.a, { ...r.u, usd: c, turns: 1 })
    if (r.sub) g.sub += c
  }
  const total = groups.reduce((a, g) => add(a, g.a), zero())
  const label = t => t.replace(/\s+/g, ' ').trim().slice(0, 60)
  return [`This session: ${groups.length} prompts, ${total.turns} model calls, ${usd(total.usd)} estimated, cache hit ${pct(hit(total))}.`, '', 'Most expensive prompts:',
    ...[...groups].sort((a, b) => b.a.usd - a.a.usd).slice(0, 15).map(g => `${usd(g.a.usd).padStart(8)} ${String(g.a.turns).padStart(4)} calls ${n(g.a.input + g.a.cw + g.a.cr).padStart(7)} in ${n(g.a.out).padStart(6)} out${g.sub ? ` (${usd(g.sub)} subagents)` : ''}  ${new Date(g.from).toISOString().slice(11, 16)} "${label(g.p.text)}"`)].join('\n')
}

export async function quick(sid, now = Date.now(), dir = claudeDir()) {
  const sessions = await collect(7, now, dir)
  const today = sessions.flatMap(s => s.turns).filter(r => day(r.t) === day(now)).reduce((a, r) => add(a, { ...r.u, usd: r.usd, turns: 1 }), zero())
  const week = sessions.reduce((a, s) => add(a, s.total), zero())
  const me = sessions.find(s => s.sid === sid)
  const top = findings(sessions)[0]
  return [`Today: ${usd(today.usd)}, ${today.turns} model calls. Last 7 days: ${usd(week.usd)} over ${sessions.length} sessions, cache hit ${pct(hit(week))}.`,
    me ? `This session: ${usd(me.total.usd)}, ${me.total.turns} model calls, ${me.compactions} compaction(s).` : 'This session: no usage recorded yet.',
    top ? `Top suggestion (7 days): ${top.title}. ${top.fix}` : 'No waste pattern stands out this week.'].join('\n')
}

export function doctor(sid, dir = claudeDir()) {
  const ok = (good, text, fix = '') => `${good ? 'ok  ' : 'fix '} ${text}${!good && fix ? `\n      ${fix}` : ''}`
  const lines = [ok(Number(process.versions.node.split('.')[0]) >= 18, `Node ${process.versions.node}`, 'Install Node 18 or newer.')]
  const root = join(dir, 'projects')
  lines.push(ok(existsSync(root), `Transcripts folder ${root}`, 'No transcripts yet: reports stay empty until a session has run.'))
  const qf = join(dataDir(dir), `quality-${sid}.json`)
  const qAge = existsSync(qf) ? Math.round((Date.now() - statSync(qf).mtimeMs) / 60_000) : null
  lines.push(ok(qAge !== null, qAge !== null ? `Quality file for this session, updated ${qAge} min ago` : 'No quality file for this session yet', 'It is written after the first answer of a session.'))
  let settings = {}
  try { settings = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) } catch { /* none */ }
  const left = [
    ...Object.keys(settings.extraKnownMarketplaces || {}).filter(k => /token-optimizer/i.test(k)).map(k => `marketplace entry "${k}"`),
    ...Object.keys(settings.enabledPlugins || {}).filter(k => /^token-optimizer@/.test(k)).map(k => `enabledPlugins "${k}"`),
    ...Object.keys(settings.env || {}).filter(k => /^TOKEN_OPTIMIZER_/.test(k)).map(k => `env ${k}`),
    ...JSON.stringify(settings.hooks || {}).match(/measure\.py|token-optimizer/g) ? ['a hook that runs Token Optimizer'] : [],
  ]
  lines.push(ok(!left.length, left.length ? `Token Optimizer leftovers in settings.json: ${left.join(', ')}` : 'No Token Optimizer leftovers in settings.json', 'Harmless, but you can remove them by hand. token-lens does not edit them.'))
  const ids = installedPlugins(dir).map(p => p.id)
  lines.push(ok(!ids.some(i => /^token-optimizer@/.test(i)), ids.some(i => /^token-optimizer@/.test(i)) ? 'Token Optimizer is still installed' : 'Token Optimizer is not installed', 'Two optimizers would both act on tool output. Uninstall one.'))
  lines.push(ok(true, ids.some(i => /^crab-progress@/.test(i)) ? 'crab-progress is installed: its band reads token-lens quality and savings' : 'crab-progress is not installed (optional: it shows the grade above the prompt)'))
  let store = 0
  try { store = readdirSync(join(dir, 'plugins', 'store')).filter(f => f.startsWith('token-lens')).reduce((a, f) => a + statSync(join(dir, 'plugins', 'store', f)).size, 0) } catch { /* none */ }
  lines.push(ok(store < 5e6, `Store size ${n(store)} bytes`, 'Over 5 MB: run /tokens purge, or lower the archive with /tokens compress off.'))
  return ['token-lens doctor', '', ...lines].join('\n')
}

// MEMORY.md files that load into every session: size, long lines, broken and missing links, duplicates.
export function memory(cwd, dir = claudeDir()) {
  const dirs = []
  for (let d = resolve(cwd), i = 0; i < 6; d = dirname(d), i++) {
    dirs.push(join(dir, 'projects', d.replace(/[^A-Za-z0-9]/g, '-'), 'memory'), join(d, 'memory'))
    if (dirname(d) === d) break
  }
  const found = [...new Set(dirs)].filter(m => existsSync(join(m, 'MEMORY.md')) && plain(dirname(m), join(m, 'MEMORY.md')))
  if (!found.length) return `No MEMORY.md found for ${cwd} or its parents.`
  return found.map(m => {
    const text = readSmall(join(m, 'MEMORY.md')) ?? ''
    const lines = text.split(/\r?\n/)
    const tips = []
    const longL = lines.filter(l => l.length > 200).length
    if (longL) tips.push(`${longL} line(s) over 200 characters. Keep each index line short; the detail belongs in the linked file.`)
    if (lines.length > 150) tips.push(`${lines.length} lines. Only the start may load; move old entries out.`)
    const links = [...text.matchAll(/\]\(([^)\s]+\.md)\)/g)].map(x => x[1])
    const missing = links.filter(l => !existsSync(join(m, l)))
    if (missing.length) tips.push(`Links to missing files: ${missing.slice(0, 6).map(cap).join(', ')}.`)
    let files = []
    try { files = readdirSync(m).filter(f => f.endsWith('.md') && f !== 'MEMORY.md') } catch { /* none */ }
    const orphans = files.filter(f => !links.includes(f))
    if (orphans.length) tips.push(`Memory files not linked from the index (never recalled): ${orphans.slice(0, 6).map(cap).join(', ')}.`)
    const seen = new Set(), dups = new Set()
    for (const l of lines.map(x => x.trim()).filter(Boolean)) (seen.has(l) ? dups : seen).add(l)
    if (dups.size) tips.push(`${dups.size} duplicate line(s).`)
    const all = files.reduce((a, f) => a + (statSync(join(m, f)).size || 0), 0)
    return [`${join(m, 'MEMORY.md')}: ${lines.length} lines, about ${tok(text.length)} tokens loaded every session; ${files.length} memory files (${tok(all)} tokens, read on demand).`,
      ...(tips.length ? tips.map(t => `- ${t}`) : ['- Looks tidy.'])].join('\n')
  }).map(strip).join('\n\n')
}

// An absolute folder that is never created: as core.hooksPath it means no repository hook runs.
const NO_HOOKS = join(dirname(fileURLToPath(import.meta.url)), 'no-hooks')

// What the uncommitted changes would cost to read. Plain git commands with lazy fetch (a partial clone's
// configured remote command), repository hooks, fsmonitor, external diff, text conversion and submodules turned off.
export function gitContext(cwd) {
  const git = args => execFileSync('git', ['--no-lazy-fetch', '--no-optional-locks', '-c', `core.hooksPath=${NO_HOOKS}`, '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', ...args], { cwd, encoding: 'utf8', timeout: 20_000, maxBuffer: 20e6, stdio: ['ignore', 'pipe', 'ignore'] })
  // A filter in the repository's own config (local or worktree) runs a command on `git status`, and core.worktree
  // points git at another folder, so none of it runs then.
  let risky = ''
  try { risky = git(['config', '--show-scope', '--includes', '--get-regexp', '^(filter\\.|core\\.worktree$)']) } catch (err) {
    // Exit 1 means none is set. Any other failure (git older than 2.45 has no --no-lazy-fetch) proves nothing.
    if (err.status !== 1) return 'Not run: git could not check this repository config (git missing, or older than 2.45).'
  }
  if (risky.split('\n').some(l => /^(local|worktree)\s/.test(l))) return 'Not run: this repository config sets git filter commands or core.worktree.'
  let status
  try { status = git(['status', '--porcelain=v1', '-uall', '--ignore-submodules=all']) } catch { return 'Not a git repository (or git is not installed).' }
  const rows = status.split('\n').filter(Boolean).map(l => ({ code: l.slice(0, 2), file: l.slice(3).replace(/^.* -> /, '').replace(/^"|"$/g, '') }))
  if (!rows.length) return 'No uncommitted changes.'
  let diff = 0
  try { diff = git(['diff', 'HEAD', '--no-ext-diff', '--no-textconv', '--no-color', '--ignore-submodules=all']).length } catch { /* no HEAD yet */ }
  const sized = rows.map(r => { let s = 0; try { const st = lstatSync(join(cwd, r.file)); s = st.isFile() ? st.size : 0 } catch { /* deleted */ } return { ...r, s } }).sort((a, b) => b.s - a.s)
  const whole = sized.reduce((a, r) => a + r.s, 0)
  return [`${rows.length} changed file(s). Reading them whole: about ${n(tok(whole))} tokens. The diff alone: about ${n(tok(diff))} tokens.`, '',
    ...sized.slice(0, 15).map(r => `  ${r.code} ${n(tok(r.s)).padStart(7)}  ${cap(r.file)}`),
    ...(rows.length > 15 ? [`  ... and ${rows.length - 15} more`] : []), '',
    whole > 2 * diff && diff ? 'Tip: ask Claude to read `git diff` rather than the whole files when reviewing these changes.' : 'Tip: the files are small; reading them whole is fine.'].map(strip).join('\n')
}

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

export async function dashboard(days, savings = {}, now = Date.now(), dir = claudeDir()) {
  const sessions = await collect(days, now, dir)
  const total = sessions.reduce((a, s) => add(a, s.total), zero())
  const byDay = new Map(), byProj = new Map(), byModel = new Map()
  for (const s of sessions) {
    byProj.set(s.label, add(byProj.get(s.label) || zero(), s.total))
    for (const r of s.turns) {
      byDay.set(day(r.t), (byDay.get(day(r.t)) || 0) + r.usd)
      byModel.set(r.model || 'unknown', add(byModel.get(r.model || 'unknown') || zero(), { ...r.u, usd: r.usd, turns: 1 }))
    }
  }
  const dates = Array.from({ length: days }, (_, i) => day(now - (days - 1 - i) * 864e5))
  const peak = Math.max(0.01, ...dates.map(d => byDay.get(d) || 0))
  const w = 720, h = 140, bw = w / dates.length
  const bars = dates.map((d, i) => { const v = byDay.get(d) || 0, bh = Math.round((v / peak) * (h - 10)); return `<rect x="${(i * bw + 1).toFixed(1)}" y="${h - bh}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${bh}" rx="2"><title>${d}: ${usd(v)}</title></rect>` }).join('')
  const q = qualityFiles(days, now, dir)
  const table = (rows, head) => `<table><tr>${head.map(x => `<th>${x}</th>`).join('')}</tr>${rows.map(r => `<tr>${r.map(x => `<td>${esc(x)}</td>`).join('')}</tr>`).join('')}</table>`
  const top = (m, k) => [...m].sort((a, b) => b[1].usd - a[1].usd).slice(0, k)
  const saved = Number(savings.total_30d_tokens) || 0
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>token-lens dashboard</title><style>
:root{--bg:#faf9f6;--fg:#1f1e1c;--mute:#6b6862;--card:#fff;--line:#e6e3dc;--bar:#c96442}
@media (prefers-color-scheme:dark){:root{--bg:#1c1b19;--fg:#ecebe7;--mute:#a19e97;--card:#262522;--line:#3a3833;--bar:#d97757}}
body{margin:0;padding:24px 16px;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif}main{max-width:860px;margin:0 auto}
h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:28px 0 8px}.mute{color:var(--mute)}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-top:16px}.kpi{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px}.kpi b{display:block;font-size:20px}
svg{width:100%;height:auto;background:var(--card);border:1px solid var(--line);border-radius:10px}rect{fill:var(--bar)}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}th,td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--line)}td:not(:first-child),th:not(:first-child){text-align:right}
ol{padding-left:20px}li{margin-bottom:8px}.wrap{overflow-x:auto}</style></head><body><main>
<h1>token-lens</h1><div class="mute">Last ${days} days, made ${esc(new Date(now).toISOString().slice(0, 16).replace('T', ' '))} UTC. Local file, no network. Costs are estimates at list prices as of ${PRICES_AS_OF}.</div>
<div class="kpis"><div class="kpi"><span class="mute">Estimated cost</span><b>${usd(total.usd)}</b></div><div class="kpi"><span class="mute">Sessions</span><b>${sessions.length}</b></div><div class="kpi"><span class="mute">Cache hit</span><b>${pct(hit(total))}</b></div><div class="kpi"><span class="mute">Saved by token-lens (30 d)</span><b>${n(saved)} tokens</b></div><div class="kpi"><span class="mute">Average quality</span><b>${q.length ? (q.reduce((a, x) => a + x.score, 0) / q.length).toFixed(0) : 'n/a'}</b></div></div>
<h2>Cost per day</h2><svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Estimated cost per day">${bars}</svg>
<h2>Suggestions</h2><ol>${findings(sessions, q).slice(0, 8).map(f => `<li><b>${esc(f.title)}.</b> ${esc(f.detail)}<br><span class="mute">${esc(f.fix)}</span></li>`).join('') || '<li>No waste pattern stands out.</li>'}</ol>
<h2>By project</h2><div class="wrap">${table(top(byProj, 10).map(([p, a]) => [p.split(/[\\/]/).slice(-2).join('/'), a.turns, n(a.input + a.out + a.cw + a.cr), pct(hit(a)), usd(a.usd)]), ['Project', 'Calls', 'Tokens', 'Cache hit', 'Cost'])}</div>
<h2>By model</h2><div class="wrap">${table(top(byModel, 8).map(([m, a]) => [m, a.turns, n(a.input + a.out + a.cw + a.cr), pct(hit(a)), usd(a.usd)]), ['Model', 'Calls', 'Tokens', 'Cache hit', 'Cost'])}</div>
<h2>Recent session grades</h2><div class="wrap">${table(q.slice(0, 15).map(x => [x.sid.slice(0, 8), new Date(x.at).toISOString().slice(0, 16).replace('T', ' '), x.score, x.grade]), ['Session', 'Last update (UTC)', 'Score', 'Grade'])}</div>
</main></body></html>`
  mkdirSync(dataDir(dir), { recursive: true })
  const file = join(dataDir(dir), 'dashboard.html')
  writeFileSync(file, html)
  return file
}

export function open(file) {
  const [cmd, args] = process.platform === 'win32' ? ['explorer.exe', [file]] : process.platform === 'darwin' ? ['open', [file]] : ['xdg-open', [file]]
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref()
}

// Deletes token-lens's own quality files older than 14 days. Nothing else.
export function prune(now = Date.now(), dir = claudeDir()) {
  const d = dataDir(dir)
  let gone = 0
  try {
    for (const f of readdirSync(d).filter(x => /^quality-[\w-]+\.json$/.test(x))) {
      const p = join(d, f)
      if (lstatSync(p).isFile() && now - statSync(p).mtimeMs > 14 * 864e5) { unlinkSync(p); gone++ }
    }
  } catch { /* no folder yet */ }
  return `Deleted ${gone} old quality file(s).`
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, arg, extra] = process.argv.slice(2)
  const days = Math.min(365, Number(arg) || 30)
  const modes = {
    plan: async () => JSON.stringify(await plan(days)),
    usage: () => usage(days),
    audit: () => audit(arg || process.cwd()),
    trends: () => trends(days),
    drift: () => drift(),
    coach: () => coach(days),
    route: () => route(days),
    conversation: () => conversation(arg || ''),
    quick: () => quick(arg || ''),
    doctor: () => doctor(arg || ''),
    memory: () => memory(arg || process.cwd()),
    git: () => gitContext(arg || process.cwd()),
    dashboard: async () => { const f = await dashboard(days, { total_30d_tokens: Number(extra) || 0 }); open(f); return `Dashboard written to ${f}; opening it.` },
    prune: () => prune(),
  }
  const out = modes[mode] ? await modes[mode]() : `usage: scan.mjs ${Object.keys(modes).join(' | ')}`
  process.stdout.write(strip(out) + '\n')
}
