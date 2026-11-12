import { expect, mock, test } from 'claude-code/testing'

import type { On } from 'claude-code'

import { buildCheckpoint, doomed, modeOf, projKey, redact, RETAIN_MS } from '../hooks/checkpoint'
import { compress, cut, fold, reread } from '../hooks/compress'
import { nudges, similarity, type NudgeInput } from '../hooks/nudges'
import { gradeOf, quality } from '../hooks/quality'

// What every session.start of the mod asks for.
const boot = (on: On) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'tokens' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__token-lens__expand' } }))
  on('session.root', () => ({ value: '/p' }))
  on('session.id', () => ({ value: 'abcd1234ef' }))
  on('session.turns', () => ({ value: 3 }))
}

test('redact removes keys, tokens, passwords and url credentials', () => {
  // Built from parts so no key-shaped literal sits in the repository.
  const s = ['sk-' + 'abcdefghijklmnopqrstuvwx', 'gh' + 'p_' + 'abcdefghijklmnopqrstuvwxyz1234', 'API_KEY=hunter2hunter2', 'Bearer abcdefghijklmnopqrstuv', 'https://bob:pw123456@host/x', 'AK' + 'IA' + 'ABCDEFGHIJKLMNOP'].join(' ')
  const r = redact(s)
  for (const bad of ['sk-abc', 'ghp_', 'hunter2', 'abcdefghijklmnopqrstuv', 'pw123456', 'AKIA']) expect(r).not.toContain(bad)
})

test('checkpoint keeps task, edited files and decisions, redacted', () => {
  const msgs = [
    { role: 'user', text: 'fix the login, token=abcdef123456', toolUses: [] },
    { role: 'assistant', text: 'We decided to use sessions instead of JWT. Starting now.', toolUses: [{ tool: 'Edit', input: { file_path: 'src/a.ts' } }, { tool: 'Read', input: { file_path: 'src/b.ts' } }] },
  ] as never
  const cp = buildCheckpoint(msgs, 1000, 'abcd1234', '/proj')
  expect(cp.task).toContain('fix the login')
  expect(cp.task).not.toContain('abcdef123456')
  expect(cp.files).toEqual(['src/a.ts'])
  expect(cp.decisions.length).toBe(1)
})

test('retention drops old checkpoints and caps a project at 10', () => {
  const now = 100 * RETAIN_MS
  const old = `cp:p:${now - RETAIN_MS - 1}`
  const fresh = Array.from({ length: 12 }, (_, i) => `cp:p:${now - i * 1000}`)
  const gone = doomed([old, ...fresh, 'other'], now)
  expect(gone).toContain(old)
  expect(gone.length).toBe(3)
  expect(gone).not.toContain('other')
})

test('a compaction saves a checkpoint and is passed on untouched; restore and purge work', async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: 5_000 })
  const kept = [{ role: 'user', text: 'ship it', toolUses: [], toolResults: [] }] as never
  let seen: unknown
  boot(on)
  on('ui.toast', () => ({ value: undefined }))
  on('session.compact', { trigger: 'manual' }, (_, e) => { seen = e.messages; return { messages: kept } as never })
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true } as never)
  await $.session.compact({ trigger: 'manual', messages: kept } as never)
  expect(seen).toBeDefined()
  const restored = (await $.command.run({ command: 'tokens', args: 'restore' } as never)) as { text?: string; context?: string[] }
  expect(String(restored.text)).toContain('ship it')
  expect(restored.context?.length).toBe(1)
  const purged = (await $.command.run({ command: 'tokens', args: 'purge' } as never)) as { text?: string }
  expect(String(purged.text)).toContain('Deleted 2') // the checkpoint and the session's compaction count
  const none = (await $.command.run({ command: 'tokens', args: 'restore' } as never)) as { text?: string }
  expect(String(none.text)).toContain('No checkpoint')
})

test('after a compaction the summarizer is told what to keep and the checkpoint is added back, labelled', async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: 5_000 })
  const session = mock.session(on)
  let told: string | undefined
  boot(on)
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.compact', { trigger: 'manual' }, (_, e) => { told = e.instructions; return { messages: e.messages } as never })
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true } as never)
  const msgs = [{ role: 'user', text: 'refactor the parser', toolUses: [], toolResults: [] }] as never
  await $.session.compact({ trigger: 'manual', messages: msgs } as never)
  expect(told).toContain('refactor the parser')
  expect(JSON.stringify(session.appended())).toContain('added automatically after compaction')
})

test('a compaction writes the quality file again, so the crab band shows the new checkpoint time', async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: 7_000_000 })
  mock.env(on, { CLAUDE_CONFIG_DIR: '/c' })
  mock.session(on)
  boot(on)
  on('session.usage', () => ({ value: { startedAt: 1_000_000, context: { window: 200_000, percent: 9 }, rateLimits: [] } }))
  on('session.messages', () => ({ value: [] as never }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  const files: Record<string, string> = {}
  on('fs.write', (_, e) => { const x = e as unknown as { path: string; text: string }; files[x.path] = x.text; return { value: undefined } })
  on('session.compact', { trigger: 'manual' }, (_, e) => ({ messages: e.messages }) as never)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true } as never)
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'ship it', toolUses: [], toolResults: [] }] } as never)
  const path = Object.keys(files).find(f => /[\\/]c[\\/]token-lens[\\/]quality-abcd1234ef\.json$/.test(f))
  const q = JSON.parse(path ? files[path] : '{}')
  expect(q.last_checkpoint_epoch).toBe(7000)
  expect(q.compactions).toBe(1)
})

test('/tokens auto run turns off an unused plugin after a backup, and /tokens undo turns it back on', async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: 9_000_000_000 })
  let file = JSON.stringify({ enabledPlugins: { 'old@m': true, 'keep@m': true }, cleanupPeriodDays: 30 })
  const plan = { days: 30, sessions: 40, compactions: 3, settingsPath: '/s.json', candidates: [{ id: 'old@m', tokens: 100, skills: 1, agents: 0, servers: 0 }] }
  boot(on)
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify(plan), stderr: '' } }))
  on('fs.read', () => ({ value: file }))
  on('fs.write', (_, e) => { file = (e as unknown as { text: string }).text; return { value: undefined } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as never)
  const run = (await $.command.run({ command: 'tokens', args: 'auto run' } as never)) as { text?: string }
  expect(String(run.text)).toContain('old@m')
  const s = JSON.parse(file)
  expect(s.enabledPlugins['old@m']).toBe(false)
  expect(s.enabledPlugins['keep@m']).toBe(true)
  expect(s.cleanupPeriodDays).toBe(30)
  await $.command.run({ command: 'tokens', args: 'undo' } as never)
  expect(JSON.parse(file).enabledPlugins['old@m']).toBe(true)
})

test('/tokens auto off stops the automatic run and the plan shows what would change', async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: 9_000_000_000 })
  const plan = { days: 30, sessions: 40, compactions: 3, settingsPath: '/s.json', candidates: [{ id: 'old@m', tokens: 100, skills: 1, agents: 0, servers: 0 }] }
  boot(on)
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify(plan), stderr: '' } }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as never)
  const off = (await $.command.run({ command: 'tokens', args: 'auto off' } as never)) as { text?: string }
  expect(String(off.text)).toContain('off')
  const p = (await $.command.run({ command: 'tokens', args: 'plan' } as never)) as { text?: string }
  expect(String(p.text)).toContain('old@m')
})

test('redaction stays fast on a huge crafted text, and catches a long-named key', () => {
  const t0 = Date.now()
  const cp = buildCheckpoint([{ role: 'user', text: 'key'.repeat(300_000), toolUses: [] }] as never, 1, 'sid', '/p')
  expect(Date.now() - t0).toBeLessThan(1000)
  expect(cp.task.length).toBeLessThan(310)
  expect(redact('very_long_name_for_the_api_key = abcdef123456')).not.toContain('abcdef123456')
})

test('two project roots that differ only in punctuation keep separate checkpoints', () => {
  expect(projKey('/a/b')).not.toBe(projKey('/a-b'))
})

test('/tokens undo needs no scan, uses the logged file, backs it up, and skips plugins already on', async ($, on) => {
  mock.store(on, { changes: [{ at: 1, id: 'old@m', file: '/s.json' }, { at: 1, id: 'already@m', file: '/s.json' }] })
  mock.clock(on, { now: 9_000_000_000 })
  let file = JSON.stringify({ enabledPlugins: { 'old@m': false, 'already@m': true } })
  boot(on)
  on('process.run', () => { throw new Error('undo must not run a scan') })
  on('fs.read', () => ({ value: file }))
  on('fs.write', (_, e) => { file = (e as unknown as { text: string }).text; return { value: undefined } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as never)
  const r = (await $.command.run({ command: 'tokens', args: 'undo' } as never)) as { text?: string }
  expect(String(r.text)).toContain('old@m')
  expect(String(r.text)).not.toContain('already@m')
  expect(JSON.parse(file).enabledPlugins['old@m']).toBe(true)
  const again = (await $.command.run({ command: 'tokens', args: 'undo' } as never)) as { text?: string }
  expect(String(again.text)).toContain('Nothing to undo')
})

test('undo works for a 0.2.0 log entry with no file, using the newest backup file', async ($, on) => {
  mock.store(on, { changes: [{ at: 1, id: 'old@m' }], 'backup:0': { at: 5, file: '/s.json', enabledPlugins: {} } })
  mock.clock(on, { now: 9_000_000_000 })
  let file = JSON.stringify({ enabledPlugins: { 'old@m': false } })
  boot(on)
  on('fs.read', () => ({ value: file }))
  on('fs.write', (_, e) => { file = (e as unknown as { text: string }).text; return { value: undefined } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as never)
  const r = (await $.command.run({ command: 'tokens', args: 'undo' } as never)) as { text?: string }
  expect(String(r.text)).toContain('old@m')
  expect(JSON.parse(file).enabledPlugins['old@m']).toBe(true)
})

test('a settings file that stops parsing after the write is restored and the undo log is kept', async ($, on) => {
  mock.store(on, { changes: [{ at: 1, id: 'old@m', file: '/s.json' }] })
  mock.clock(on, { now: 9_000_000_000 })
  const original = JSON.stringify({ enabledPlugins: { 'old@m': false } })
  let file = original
  let writes = 0
  boot(on)
  on('fs.read', () => ({ value: file }))
  on('fs.write', (_, e) => { writes++; file = writes === 1 ? '{broken' : (e as unknown as { text: string }).text; return { value: undefined } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as never)
  const r = (await $.command.run({ command: 'tokens', args: 'undo' } as never)) as { text?: string }
  expect(String(r.text)).toContain('Could not update')
  expect(file).toBe(original)
  const keep = (await $.command.run({ command: 'tokens', args: 'undo' } as never)) as { text?: string }
  expect(String(keep.text)).not.toContain('Nothing to undo')
})

test('a secret split by the cut leaves no fragment, and a 0.2.0 backup is trimmed to the plugin flags', async ($, on) => {
  const text = 'x '.repeat(500) + 'gh' + 'p_' + 'a'.repeat(36)
  const cp = buildCheckpoint([{ role: 'user', text, toolUses: [] }] as never, 1, 'sid', '/p')
  expect(cp.task).not.toContain('ghp_')
  const db: Record<string, unknown> = { 'backup:0': { at: 1, file: '/s.json', text: JSON.stringify({ env: { K: 'SECRETVALUE' }, enabledPlugins: { 'a@m': false } }) } }
  const written: unknown[] = []
  mock.clock(on, { now: 9_000_000_000 })
  on('store.get', (_, e) => ({ value: db[(e as unknown as { key: string }).key] }))
  on('store.keys', () => ({ value: Object.keys(db) }))
  on('store.delete', () => ({ value: undefined }))
  on('store.set', (_, e) => { const x = e as unknown as { key: string; value: unknown }; db[x.key] = x.value; written.push(x); return { value: undefined } })
  boot(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as never)
  const out = JSON.stringify(written)
  expect(out).toContain('backup:0')
  expect(out).not.toContain('SECRETVALUE')
  expect(out).toContain('a@m')
})

// ---- pure helpers added in 0.3.0 ----

test('fold strips colour codes, keeps the last progress frame and folds repeated lines', () => {
  const t = fold('\x1b[32mok\x1b[0m\n10%\r50%\r100%\n' + 'same\n'.repeat(5) + 'end')
  expect(t).toBe('ok\n100%\nsame\n[token-lens: the line above repeats 4 more times]\nend')
})

test('compress leaves a small saving alone and cuts long output to its start and end, naming the id', () => {
  expect(compress('a\nb\nc', 'id1')).toBeNull()
  const long = Array.from({ length: 3000 }, (_, i) => `row ${i}`).join('\n')
  const c = compress(long, 'toolu_9')!
  expect(c.archived).toBe(true)
  expect(c.text).toContain('row 0')
  expect(c.text).toContain('row 2999')
  expect(c.text).toContain('id "toolu_9"')
  expect(c.text.length).toBeLessThan(5000)
  expect(cut('short', 'x')).toBe('short')
})

test('reread: outline for an unchanged range, changed lines only for a small change, full text otherwise', () => {
  const lines = Array.from({ length: 120 }, (_, i) => (i % 20 === 0 ? `export function f${i}() {` : `  total += ${i} // padding text to make the file long enough`))
  const a = lines.join('\n')
  const prev = { at: 0, content: a }
  const same = reread(prev, a, 1, 60_000, 'r1')!
  expect(same).toContain('unchanged')
  expect(same).toContain('  1: export function f0() {')
  expect(same).not.toContain('total += 1 ')
  const b = [...lines.slice(0, 50), '  const changed = true', ...lines.slice(51)].join('\n')
  const delta = reread(prev, b, 1, 60_000, 'r2')!
  expect(delta).toContain('Lines 51-51')
  expect(delta).toContain('51:   const changed = true')
  expect(reread(prev, a, 1, 31 * 60_000, 'r3')).toBeNull()
  expect(reread(undefined, a, 1, 0, 'r4')).toBeNull()
  expect(reread(prev, lines.map(l => l + ' x').join('\n'), 1, 60_000, 'r5')).toBeNull()
})

test('quality grades a clean session S, names stale reads and a full context as the drag', () => {
  const read = (p: string, n: number) => ({ tool: 'Read', input: { file_path: p }, text: 'x'.repeat(n) })
  const clean = quality([{ role: 'assistant', text: 'done', toolUses: [{ tool: 'Edit', input: {} }] }], 10, 0)
  expect(clean.grade).toBe('S')
  expect(clean.top_drag).toBeNull()
  const twice = Array.from({ length: 20 }, (_, i) => [read(`/f${i}`, 7900), read(`/f${i}`, 7900)]).flat()
  const messy = quality([{ role: 'assistant', text: '', toolUses: twice }], 30, 0)
  expect(messy.score).toBeLessThan(clean.score)
  expect(messy.top_drag?.key).toBe('stale_reads')
  const full = quality([], 95, 3)
  expect(full.grade).toBe('C')
  expect(full.top_drag?.key).toBe('context_fill')
  expect(gradeOf(90)).toBe('S')
  expect(gradeOf(39)).toBe('F')
})

test('nudges: none unless turned on; each is labelled and held back by its band or cooldown', () => {
  const base: NudgeInput = { on: [], now: 600_000, fill: 80, score: 30, drag: null, prompts: ['fix the lexer crash', 'fix the lexer crash'], uses: [], model: 'claude-opus-5-5' }
  expect(nudges(base, {}).lines).toEqual([])
  const all = nudges({ ...base, on: ['lean', 'quality', 'loop'] }, {})
  expect(all.lines.length).toBe(3)
  for (const l of all.lines) expect(l).toMatch(/^\[token-lens nudge: \w+\. \/tokens nudge \w+ off stops it\]/)
  expect(nudges({ ...base, on: ['lean', 'quality'], now: 660_000 }, all.st).lines).toEqual([])
  const route = nudges({ ...base, on: ['route'], now: 3_600_000, prompts: ['rename foo to bar'] }, {})
  expect(route.lines[0]).toContain('nudge: route')
  const err = { tool: 'Bash', isError: true }
  const fails = nudges({ ...base, on: ['loop'], prompts: ['go'], uses: [err, err, err] }, {})
  expect(fails.lines[0]).toContain('last 3 tool calls failed')
  expect(similarity('fix the lexer crash', 'fix the lexer crash now')).toBeGreaterThan(0.7)
})

test('the checkpoint records the kind of work, files read most and the last errors', () => {
  const u = (tool: string, file: string, isError?: true) => ({ tool, input: { file_path: file }, ...(isError ? { isError, text: 'ENOENT' } : {}) })
  const msgs = [
    { role: 'user', text: 'the build is broken, fix it', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [u('Read', '/a.ts'), u('Read', '/a.ts'), u('Bash', '', true), u('Bash', '', true), u('Bash', '', true)] },
  ] as never
  const cp = buildCheckpoint(msgs, 1, 'sid', '/p', 'periodic')
  expect(cp.mode).toBe('debugging')
  expect(cp.reads).toEqual(['/a.ts'])
  expect(cp.errors?.length).toBe(3)
  expect(cp.why).toBe('periodic')
  expect(modeOf([{ role: 'assistant', text: '', toolUses: Array.from({ length: 5 }, () => u('Edit', '/d.md')) }] as never)).toBe('writing')
  const withheld = { tool: 'Read', input: { file_path: '/a.ts' }, isError: true, text: '[token-lens: this range is unchanged]' }
  const own = buildCheckpoint([{ role: 'user', text: 'go on', toolUses: [] }, { role: 'assistant', text: '', toolUses: [withheld, withheld, withheld, u('Read', '/b.ts'), u('Read', '/c.ts')] }] as never, 1, 'sid', '/p')
  expect(own.mode).not.toBe('debugging')
  expect(own.errors).toEqual([])
})

test('a fold that only strips colour codes still carries a label', () => {
  const coloured = Array.from({ length: 100 }, (_, i) => `\x1b[32mline ${i}\x1b[0m`).join('\n')
  expect(compress(coloured, 'id2')!.text).toContain('[token-lens: colour codes and progress redraws removed')
})

// ---- hooks added in 0.3.0 ----

const LONG = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n')
const live = (on: On, percent = 5, messages: unknown[] = [{ role: 'user', text: 'fix the parser crash in the lexer', toolUses: [] }]) => {
  on('session.messages', () => ({ value: messages as never }))
  on('session.model', () => ({ value: 'claude-sonnet-5-5' }))
  on('session.usage', () => ({ value: { startedAt: 1_000_000, context: { window: 200_000, percent }, rateLimits: [] } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
}

test('long Bash output is cut and labelled, expand gives it back, and /tokens compress bash off stops it', async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: 5_000 })
  boot(on)
  live(on)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: LONG, stderr: '', interrupted: false } }) as never)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true } as never)
  const r = JSON.stringify(await $.tool.call({ tool: 'Bash', tool_use_id: 'toolu_1', command: 'seq 2000' } as never))
  expect(r).toContain('line 0')
  expect(r).toContain('line 1999')
  expect(r).not.toContain('line 1000')
  expect(r).toContain('toolu_1')
  const back = JSON.stringify(await $.tool.call({ tool: 'mcp__token-lens__expand', tool_use_id: 'toolu_2', id: 'toolu_1' } as never))
  expect(back).toContain('line 1000')
  const q = (await $.command.run({ command: 'tokens', args: 'quality' } as never)) as { text?: string }
  expect(String(q.text)).toMatch(/Saved by token-lens compression: [1-9]\d* tokens this session/)
  await $.command.run({ command: 'tokens', args: 'compress bash off' } as never)
  const raw = JSON.stringify(await $.tool.call({ tool: 'Bash', tool_use_id: 'toolu_3', command: 'seq 2000' } as never))
  expect(raw).toContain('line 1000')
  expect(raw).not.toContain('token-lens')
})

test('a repeat Read of an unchanged file is withheld with an outline; the first Read goes through', async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: 5_000 })
  boot(on)
  live(on)
  const content = Array.from({ length: 100 }, (_, i) => (i % 25 === 0 ? `export function f${i}() {` : `  total += ${i} // a long enough line of padding`)).join('\n')
  on('tool.call', { tool: 'Read' }, () => ({ result: { type: 'text', file: { filePath: '/p/a.ts', content, numLines: 100, startLine: 1, totalLines: 100 } } }) as never)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true } as never)
  const first = JSON.stringify(await $.tool.call({ tool: 'Read', tool_use_id: 'toolu_1', file_path: '/p/a.ts' } as never))
  expect(first).toContain('total += 1 ')
  const second = JSON.stringify(await $.tool.call({ tool: 'Read', tool_use_id: 'toolu_2', file_path: '/p/a.ts' } as never))
  expect(second).toContain('unchanged')
  expect(second).toContain('export function f25')
  expect(second).not.toContain('total += 1 ')
})

test('a nudge is added to the prompt only after it is turned on, and is labelled', async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: 5_000 })
  boot(on)
  live(on)
  let ctx: unknown
  on('prompt.submit', (_, e) => { ctx = e.context; return { text: e.text } as never })
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true } as never)
  const send = () => $.prompt.submit({ text: 'fix the parser crash in the lexer', wait: false, origin: { kind: 'composer' } } as never)
  await send()
  expect(JSON.stringify(ctx ?? [])).not.toContain('token-lens')
  await $.command.run({ command: 'tokens', args: 'nudge loop on' } as never)
  await send()
  expect(JSON.stringify(ctx)).toContain('[token-lens nudge: loop.')
})

test('after an answer the grade, a checkpoint and the savings go to the token-lens folder for the crab band', async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: 5_000_000 })
  mock.env(on, { CLAUDE_CONFIG_DIR: '/c' })
  boot(on)
  live(on, 42, [{ role: 'user', text: 'add a test', toolUses: [] }, { role: 'assistant', text: 'ok', toolUses: [{ tool: 'Edit', input: { file_path: '/p/a.ts' } }] }])
  const files: Record<string, string> = {}
  on('fs.write', (_, e) => { const x = e as unknown as { path: string; text: string }; files[x.path] = x.text; return { value: undefined } })
  on('turn.complete', () => ({ text: 'ok' }) as never)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true } as never)
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never)
  // The engine gives fs.write the path in the platform's own form.
  const path = Object.keys(files).find(f => /[\\/]c[\\/]token-lens[\\/]quality-abcd1234ef\.json$/.test(f))
  const q = JSON.parse(path ? files[path] : '{}')
  expect(q.grade).toMatch(/^[SABCDF]$/)
  expect(q.fill_pct).toBe(42)
  expect(q.session_start_ts).toBe(1000)
  expect(q.last_checkpoint_epoch).toBe(5000)
  expect(q.status.savings.daily.length).toBe(30)
  const list = (await $.command.run({ command: 'tokens', args: 'checkpoints' } as never)) as { text?: string }
  expect(String(list.text)).toContain('[periodic]')
})
