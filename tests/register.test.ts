import { expect, mock, test } from 'claude-code/testing'

import { buildCheckpoint, doomed, redact, RETAIN_MS } from '../hooks/checkpoint'

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
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'tokens' } }))
  on('session.root', () => ({ value: '/p' }))
  on('session.id', () => ({ value: 'abcd1234ef' }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.compact', { trigger: 'manual' }, (_, e) => { seen = e.messages; return { messages: kept } as never })
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true } as never)
  await $.session.compact({ trigger: 'manual', messages: kept } as never)
  expect(seen).toBeDefined()
  const restored = (await $.command.run({ command: 'tokens', args: 'restore' } as never)) as { text?: string; context?: string[] }
  expect(String(restored.text)).toContain('ship it')
  expect(restored.context?.length).toBe(1)
  const purged = (await $.command.run({ command: 'tokens', args: 'purge' } as never)) as { text?: string }
  expect(String(purged.text)).toContain('Deleted 1')
  const none = (await $.command.run({ command: 'tokens', args: 'restore' } as never)) as { text?: string }
  expect(String(none.text)).toContain('No checkpoint')
})

test('after a compaction the summarizer is told what to keep and the checkpoint is added back, labelled', async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: 5_000 })
  const session = mock.session(on)
  let told: string | undefined
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'tokens' } }))
  on('session.root', () => ({ value: '/p' }))
  on('session.id', () => ({ value: 'abcd1234ef' }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.compact', { trigger: 'manual' }, (_, e) => { told = e.instructions; return { messages: e.messages } as never })
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true } as never)
  const msgs = [{ role: 'user', text: 'refactor the parser', toolUses: [], toolResults: [] }] as never
  await $.session.compact({ trigger: 'manual', messages: msgs } as never)
  expect(told).toContain('refactor the parser')
  expect(JSON.stringify(session.appended())).toContain('added automatically after compaction')
})

test('/tokens auto run turns off an unused plugin after a backup, and /tokens undo turns it back on', async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: 9_000_000_000 })
  let file = JSON.stringify({ enabledPlugins: { 'old@m': true, 'keep@m': true }, cleanupPeriodDays: 30 })
  const plan = { days: 30, sessions: 40, compactions: 3, settingsPath: '/s.json', candidates: [{ id: 'old@m', tokens: 100, skills: 1, agents: 0, servers: 0 }] }
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'tokens' } }))
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
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'tokens' } }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify(plan), stderr: '' } }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as never)
  const off = (await $.command.run({ command: 'tokens', args: 'auto off' } as never)) as { text?: string }
  expect(String(off.text)).toContain('off')
  const p = (await $.command.run({ command: 'tokens', args: 'plan' } as never)) as { text?: string }
  expect(String(p.text)).toContain('old@m')
})
