// Read-only scanner for token-lens. Node standard library only. No network, no writes.
// Usage: node scan.mjs usage <days> | audit <cwd> | plan <days>
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

// Names come from files a repository controls: no control or escape characters reach the terminal.
const strip = t => t.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')

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
  ].join('\n')
}

// ---- audit ----

const tok = chars => Math.round(chars / 4)
function description(file) {
  let t
  try { t = readFileSync(file, 'utf8') } catch { return '' }
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
    files.push(join(d, 'CLAUDE.md'), join(d, '.claude', 'CLAUDE.md'))
    if (dirname(d) === d) break
  }
  return [...new Set(files)].filter(existsSync).map(f => {
    const text = readFileSync(f, 'utf8')
    // one level of @imports
    // Imports: regular files under 1 MB only, never a network path, never an error.
    const imp = [...text.matchAll(/^@(\S+)/gm)].map(m => m[1]).filter(r => !/^[\\/]{2}/.test(r)).reduce((s, r) => {
      try {
        const p = resolve(dirname(f), r)
        const st = statSync(p)
        return st.isFile() && st.size < 1e6 ? s + readFileSync(p, 'utf8').length : s
      } catch { return s }
    }, 0)
    return { file: f, chars: text.length + imp }
  })
}

function installedPlugins(dir) {
  try {
    const j = JSON.parse(readFileSync(join(dir, 'plugins', 'installed_plugins.json'), 'utf8'))
    return Object.entries(j.plugins || {}).flatMap(([id, v]) => (Array.isArray(v) ? v : [v]).slice(0, 1).map(x => ({ id, path: x.installPath, at: Date.parse(x.installedAt || x.lastUpdated) || 0 })).filter(x => x.path))
  } catch { return [] }
}

const norm = s => s.toLowerCase().replace(/(plugin|mcp|server|claude|ai)/g, '').replace(/[^a-z0-9]/g, '')
const safeHost = u => { try { return new URL(u).host } catch { return 'url' } }

function mcpServers(cwd, dir, plugins) {
  const out = []
  const take = (src, obj) => Object.entries(obj || {}).forEach(([name, c]) => out.push({ src, name, sig: c.url ? safeHost(c.url) : basename(String(c.command || '')) + ' ' + (c.args || []).filter(a => !/^-/.test(a)).slice(0, 1).join(' ') }))
  try { const j = JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf8')); take('user', j.mcpServers); take('project', (j.projects?.[cwd] ?? j.projects?.[cwd.replace(/\\/g, '/')])?.mcpServers) } catch { /* none */ }
  try { take('.mcp.json', JSON.parse(readFileSync(join(cwd, '.mcp.json'), 'utf8')).mcpServers) } catch { /* none */ }
  for (const p of plugins) {
    try { const j = JSON.parse(readFileSync(join(p.path, '.mcp.json'), 'utf8')); take(p.id, j.mcpServers || j) } catch { /* none */ }
  }
  return out
}

export function audit(cwd, dir = claudeDir()) {
  const plugins = installedPlugins(dir)
  const roots = [join(dir, 'skills'), join(cwd, '.claude', 'skills'), ...plugins.map(p => join(p.path, 'skills'))]
  const skills = roots.flatMap(r => [...walk(r, 3)].filter(f => basename(f) === 'SKILL.md').map(f => ({ name: basename(dirname(f)), chars: description(f).length })))
  const agentFiles = [join(dir, 'agents'), join(cwd, '.claude', 'agents'), ...plugins.map(p => join(p.path, 'agents'))].flatMap(r => [...walk(r, 2)].filter(f => f.endsWith('.md')))
  const agents = agentFiles.map(f => ({ name: basename(f, '.md'), chars: description(f).length }))
  const md = claudeMdChain(cwd, dir)
  const mcp = mcpServers(cwd, dir, plugins)
  const sum = xs => xs.reduce((s, x) => s + x.chars, 0)
  const longest = xs => [...xs].sort((a, b) => b.chars - a.chars).slice(0, 5).map(x => `  ${x.name} (${x.chars} chars)`).join('\n')
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
  for (const m of mcp) bySig.set(m.sig, [...(bySig.get(m.sig) || []), m])
  for (const [sig, g] of bySig) if (g.length > 1 && sig.trim() && new Set(g.map(m => norm(m.name))).size > 1) tips.push(`MCP servers share the same target (${sig}): ${g.map(m => m.name).join(', ')}.`)
  if (!tips.length) tips.push('Nothing stands out.')
  return [
    'Setup audit (read only; nothing was changed)',
    '',
    `CLAUDE.md: ${md.length} file(s), about ${tok(mdTotal)} tokens`, ...md.map(m => `  ${m.file} (${m.chars} chars)`),
    `Skills: ${skills.length}, descriptions about ${tok(sum(skills))} tokens. Longest:`, longest(skills),
    `Agents: ${agents.length}, descriptions about ${tok(sum(agents))} tokens. Longest:`, longest(agents),
    `MCP servers on disk: ${mcp.length}`, ...mcp.map(m => `  ${m.name} [${m.src}] ${m.sig}`),
    '  Tool counts need a live connection. Run /context to see them. Account-level connectors (for example Notion from claude.ai) are not on disk and are not listed.',
    '',
    'Suggestions (each is a change for you to approve and make):',
    ...tips.map(t => `- ${t}`),
  ].join('\n')
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, arg] = process.argv.slice(2)
  const out = mode === 'plan' ? JSON.stringify(await plan(Number(arg) || 30)) : mode === 'usage' ? await usage(Number(arg) || 30) : mode === 'audit' ? audit(arg || process.cwd()) : 'usage: scan.mjs usage <days> | audit <cwd> | plan <days>'
  process.stdout.write(strip(out) + '\n')
}
