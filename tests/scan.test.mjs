// Run: node --test tests
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { audit, cost, price, unusedPlugins, usage } from '../hooks/scan.mjs'

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
