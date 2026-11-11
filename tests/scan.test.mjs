// Run: node --test tests
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

// The audit reads <config dir>/.claude.json when this is set; keep tests off the real one.
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'tl-conf-'))

import { audit, cost, dashboard, findings, memory, plan, price, prune, qualityFiles, unusedPlugins, usage } from '../hooks/scan.mjs'

const M = 1e6
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`)

test('Opus 5.5: 4 / 20, cache read 0.20', () => {
  near(cost({ input: M, out: M, cw: 0, cr: M }, 'claude-opus-5-5'), 4 + 20 + 0.2)
  near(cost({ input: M, out: 0, cw: 0, cr: 0 }, 'claude-opus-5'), 5)
})

test('Fable 5.1: 10 / 50, cache read 0.25; Fable 5 reads at 0.1x', () => {
  near(cost({ input: M, out: M, cw: 0, cr: M }, 'claude-fable-5-1'), 10 + 50 + 0.25)
  near(cost({ input: 0, out: 0, cw: 0, cr: M }, 'claude-fable-5'), 1)
})

test('Haiku 5.5: 0.10 / 0.50 up to 100k prompt tokens, 0.50 / 2.50 beyond', () => {
  near(cost({ input: 50_000, out: M, cw: 0, cr: 0 }, 'claude-haiku-5-5'), 0.005 + 0.5)
  near(cost({ input: 150_000, out: M, cw: 0, cr: 0 }, 'claude-haiku-5-5'), 0.075 + 2.5)
  near(cost({ input: M, out: 0, cw: 0, cr: 0 }, 'claude-haiku-4-5'), 1)
})

test('1 hour cache writes cost 2x input, 5 minute 1.25x, no split falls back to 5 minute', () => {
  near(cost({ input: 0, out: 0, cw: M, cw1: M, cr: 0 }, 'claude-opus-5-5'), 8)
  near(cost({ input: 0, out: 0, cw: M, cw1: 0, cr: 0 }, 'claude-opus-5-5'), 5)
  near(cost({ input: 0, out: 0, cw: M, cw1: M / 2, cr: 0 }, 'claude-opus-5-5'), 6.5)
})

test('a family-only model is priced and called estimated; the report carries the price date', async () => {
  assert.equal(price('claude-opus-9').known, false)
  assert.equal(price('claude-opus-5-5').known, true)
  const dir = mkdtempSync(join(tmpdir(), 'tl-'))
  const p = join(dir, 'projects', 'p')
  mkdirSync(p, { recursive: true })
  const now = Date.now()
  const line = JSON.stringify({ type: 'assistant', timestamp: new Date(now).toISOString(), message: { id: 'm', model: 'claude-opus-9', usage: { input_tokens: 10, output_tokens: 10, cache_creation: { ephemeral_1h_input_tokens: 5 }, cache_creation_input_tokens: 5 } } })
  writeFileSync(join(p, 's.jsonl'), line)
  const out = await usage(30, now, dir)
  assert.match(out, /list prices as of \d{4}-\d{2}-\d{2}/)
  assert.match(out, /Estimated .*claude-opus-9/)
})

test('usage counts a repeated turn once and sums subagent files into the session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-'))
  const p = join(dir, 'projects', 'proj-a')
  mkdirSync(join(p, 's1', 'subagents'), { recursive: true })
  const turn = (id, t) => JSON.stringify({ type: 'assistant', timestamp: t, cwd: 'C:/x/proj-a', message: { id, model: 'claude-sonnet-5-5', usage: { input_tokens: 1000, output_tokens: 1000 } } })
  const now = Date.now(), ts = new Date(now).toISOString()
  writeFileSync(join(p, 's1.jsonl'), [turn('m1', ts), turn('m1', ts), turn('m2', ts)].join('\n'))
  writeFileSync(join(p, 's1', 'subagents', 'a.jsonl'), turn('m3', ts))
  const out = await usage(30, now, dir)
  assert.match(out, /3 turns/)
  assert.match(out, /proj-a/)
})

test('audit flags a server loaded twice and never prints env values', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-'))
  const cwd = mkdtempSync(join(tmpdir(), 'tl-cwd-'))
  writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { notion: { url: 'https://mcp.notion.com/mcp' }, 'plugin-notion': { url: 'https://mcp.notion.com/mcp', env: { KEY: 'SECRET123' } } } }))
  const out = audit(cwd, dir)
  assert.match(out, /more than once|share the same target/)
  assert.doesNotMatch(out, /SECRET123/)
})

test('unusedPlugins lists only old, enabled, pure plugins with no trace of use', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-'))
  const old = Date.now() - 90 * 864e5
  const mk = (name, extra) => {
    const path = join(dir, 'plugins', 'cache', name)
    mkdirSync(join(path, 'skills', `${name}-skill`), { recursive: true })
    writeFileSync(join(path, 'skills', `${name}-skill`, 'SKILL.md'), `---\nname: ${name}-skill\ndescription: does ${name} things\n---\n`)
    extra?.(path)
    return { id: `${name}@m`, path }
  }
  const plugins = [mk('idle'), mk('used'), mk('hooky', p => mkdirSync(join(p, 'hooks'))), mk('young'), mk('off')]
  writeFileSync(join(dir, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: Object.fromEntries(plugins.map(p => [p.id, [{ installPath: p.path, installedAt: new Date(p.id.startsWith('young') ? Date.now() : old).toISOString() }]])) }))
  const enabled = { 'idle@m': true, 'used@m': true, 'hooky@m': true, 'young@m': true, 'off@m': false }
  const got = unusedPlugins(dir, enabled, new Set(['skill:used:used-skill']), Date.now()).map(p => p.id)
  assert.deepEqual(got, ['idle@m'])
})

test('a stale plugin entry, a network @import and a control character do not break the scan', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-'))
  mkdirSync(join(dir, 'plugins'), { recursive: true })
  writeFileSync(join(dir, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'gone@m': [{ installPath: join(dir, 'missing') }] } }))
  assert.deepEqual(unusedPlugins(dir, { 'gone@m': true }, new Set(), Date.now()), [])
  const cwd = mkdtempSync(join(tmpdir(), 'tl-cwd-'))
  writeFileSync(join(cwd, 'CLAUDE.md'), '@//attacker.example/share/x\n@.\n')
  writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { ['evil\u001b[2Jname']: { url: 'https://h.example/x' } } }))
  const out = audit(cwd, dir)
  assert.match(out, /Setup audit/)
})

test('compactions outside the window are not counted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-'))
  const p = join(dir, 'projects', 'p')
  mkdirSync(p, { recursive: true })
  const now = Date.now()
  const line = t => JSON.stringify({ type: 'system', subtype: 'compact_boundary', timestamp: new Date(t).toISOString() })
  writeFileSync(join(p, 's.jsonl'), [line(now), line(now - 90 * 864e5)].join('\n'))
  const r = await plan(30, now, dir)
  assert.equal(r.compactions, 1)
})

test('the audit survives a CLAUDE.md that is a directory, skips symlinks and network imports, and prints no escape characters', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-'))
  const cwd = mkdtempSync(join(tmpdir(), 'tl-cwd-'))
  mkdirSync(join(cwd, 'CLAUDE.md'))
  mkdirSync(join(cwd, '.claude', 'skills', 'bad\u202ename'), { recursive: true })
  writeFileSync(join(cwd, '.claude', 'skills', 'bad\u202ename', 'SKILL.md'), '---\nname: x\ndescription: d\n---\n')
  writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { ['evil\u001b[2Jname']: { url: 'https://h.example/x' } } }))
  const out = audit(cwd, dir)
  assert.match(out, /Setup audit/)
  assert.doesNotMatch(out, /[\u001b\u202e]/)
})

test('a plugin id with control characters is ignored', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-'))
  const path = join(dir, 'plugins', 'cache', 'x')
  mkdirSync(join(path, 'skills', 's'), { recursive: true })
  writeFileSync(join(path, 'skills', 's', 'SKILL.md'), '---\nname: s\ndescription: d\n---\n')
  writeFileSync(join(dir, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'evil\u001b]0;x\u0007@m': [{ installPath: path, installedAt: '2020-01-01T00:00:00Z' }] } }))
  assert.deepEqual(unusedPlugins(dir, { 'evil\u001b]0;x\u0007@m': true }, new Set(), Date.now()), [])
})

test('a linked .claude folder in a repository is not followed', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-'))
  const cwd = mkdtempSync(join(tmpdir(), 'tl-cwd-'))
  const elsewhere = mkdtempSync(join(tmpdir(), 'tl-else-'))
  mkdirSync(join(elsewhere, 'skills', 'planted'), { recursive: true })
  writeFileSync(join(elsewhere, 'skills', 'planted', 'SKILL.md'), '---\nname: planted\ndescription: should not be read\n---\n')
  try { symlinkSync(elsewhere, join(cwd, '.claude'), 'junction') } catch { return t.skip('cannot make a link here') }
  assert.doesNotMatch(audit(cwd, dir), /planted/)
})

// ---- reports added in 0.3.0 ----

const session = (over = {}) => ({ sid: 's1', label: 'p', start: 0, end: 0, turns: [], compactions: 0, prompts: [], tools: [], models: [], total: {}, hours: 0, ...over })

test('findings rank binary reads first and report retry churn and cascades', () => {
  const fail = { name: 'Bash', key: 'Bash:{"command":"make"}', path: '', sub: false, err: true, len: 100 }
  const s = session({ tools: [{ name: 'Read', key: 'Read:a', path: '/d/spec.pdf', sub: false, err: false, len: 400_000 }, fail, fail, fail] })
  const f = findings([s])
  assert.equal(f[0].title, 'PDF and binary ingestion')
  assert.ok(f.some(x => x.title === 'Retry churn'))
  assert.ok(f.some(x => x.title === 'Tool cascades'))
  assert.equal(findings([session()]).length, 0)
})

test('findings flag small turns on a big model only when there are enough of them', () => {
  const turn = () => { const u = { input: 2000, out: 100, cw: 0, cr: 0 }; return { t: 0, model: 'claude-opus-5-5', sub: false, tools: [], text: 10, think: 0, u, usd: cost(u, 'claude-opus-5-5') } }
  const many = session({ turns: Array.from({ length: 20 }, turn) })
  assert.ok(findings([many]).some(x => x.title === 'Overpowered model'))
  const few = session({ turns: Array.from({ length: 19 }, turn) })
  assert.ok(!findings([few]).some(x => x.title === 'Overpowered model'))
})

test('findings report low grades once enough sessions are graded', () => {
  const q = ['A', 'B', 'D', 'F', 'B', 'S'].map((grade, i) => ({ sid: `s${i}`, at: 0, score: 50, grade, start: 0 }))
  assert.ok(findings([], q).some(x => x.title === 'Low grades'))
  assert.ok(!findings([], q.slice(0, 5)).some(x => x.title === 'Low grades'))
})

test('qualityFiles reads graded sessions and skips broken or foreign files; prune deletes only old quality files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-'))
  const d = join(dir, 'token-lens')
  mkdirSync(d)
  writeFileSync(join(d, 'quality-new1.json'), JSON.stringify({ score: 81, grade: 'A', session_start_ts: 1000 }))
  writeFileSync(join(d, 'quality-old1.json'), JSON.stringify({ score: 40, grade: 'D' }))
  writeFileSync(join(d, 'quality-bad1.json'), '{broken')
  writeFileSync(join(d, 'notes.json'), JSON.stringify({ score: 1 }))
  const old = (Date.now() - 20 * 864e5) / 1000
  utimesSync(join(d, 'quality-old1.json'), old, old)
  utimesSync(join(d, 'notes.json'), old, old)
  const q = qualityFiles(30, Date.now(), dir)
  assert.deepEqual(q.map(x => x.sid).sort(), ['new1', 'old1'])
  assert.equal(q.find(x => x.sid === 'new1').start, 1_000_000)
  assert.deepEqual(qualityFiles(7, Date.now(), dir).map(x => x.sid), ['new1'])
  assert.match(prune(Date.now(), dir), /Deleted 1 /)
  assert.ok(!existsSync(join(d, 'quality-old1.json')))
  assert.ok(existsSync(join(d, 'quality-new1.json')))
  assert.ok(existsSync(join(d, 'notes.json')))
  assert.match(prune(Date.now(), mkdtempSync(join(tmpdir(), 'tl-'))), /Deleted 0 /)
})

test('memory flags long lines, missing links, unlinked files and duplicates', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'tl-cwd-'))
  const m = join(cwd, 'memory')
  mkdirSync(m)
  writeFileSync(join(m, 'MEMORY.md'), ['- [A](a.md) - one', '- [Gone](gone.md) - two', '- [A](a.md) - one', 'x'.repeat(250)].join(String.fromCharCode(10)))
  writeFileSync(join(m, 'a.md'), 'fact')
  writeFileSync(join(m, 'orphan.md'), 'fact')
  const out = memory(cwd, mkdtempSync(join(tmpdir(), 'tl-')))
  assert.match(out, /over 200 characters/)
  assert.match(out, /missing files: gone\.md/)
  assert.match(out, /not linked from the index.*orphan\.md/)
  assert.match(out, /1 duplicate line/)
  assert.match(memory(mkdtempSync(join(tmpdir(), 'tl-cwd-')), mkdtempSync(join(tmpdir(), 'tl-'))), /No MEMORY\.md/)
})

test('the dashboard is one local file with the numbers in it and every name escaped', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-'))
  const p = join(dir, 'projects', 'proj')
  mkdirSync(p, { recursive: true })
  const now = Date.now()
  const line = JSON.stringify({ type: 'assistant', timestamp: new Date(now).toISOString(), cwd: 'C:/x/<b>evil</b>', message: { id: 'm', model: 'claude-sonnet-5-5', usage: { input_tokens: 1000, output_tokens: 1000 } } })
  writeFileSync(join(p, 's1.jsonl'), line)
  const file = await dashboard(7, { total_30d_tokens: 12345 }, now, dir)
  assert.equal(file, join(dir, 'token-lens', 'dashboard.html'))
  const html = readFileSync(file, 'utf8')
  assert.match(html, /<title>token-lens dashboard<\/title>/)
  assert.match(html, /12\.3k tokens|12,345 tokens|12345 tokens/)
  assert.ok(!html.includes('<b>evil'))
  assert.ok(html.includes('&lt;b&gt;evil'))
  assert.ok(!/<script/i.test(html))
})
