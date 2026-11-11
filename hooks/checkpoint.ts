// Pure helpers for checkpoints: redaction, building, formatting, retention. No `$`, no I/O.

export type Msg = { role: 'user' | 'assistant'; text: string; toolUses: { tool: string; input: Record<string, unknown>; text?: string; isError?: true }[] }
export type Mode = 'coding' | 'debugging' | 'research' | 'writing' | 'mixed'
// `reads`, `errors` and `mode` are missing on checkpoints saved before 0.3.0.
export type Checkpoint = { at: number; sid: string; project: string; task: string; prompts: string[]; files: string[]; decisions: string[]; reads?: string[]; errors?: string[]; mode?: Mode; why?: string }

export const RETAIN_MS = 14 * 24 * 3600 * 1000
export const KEEP_PER_PROJECT = 10
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const LOOK_TOOLS = new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'])
export const DECISION = /\b(decided|decision|we will|we'll use|going with|chose|instead of|the plan is)\b/i

const SECRETS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[redacted key]'],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, '[redacted]'],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, '[redacted]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[redacted]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[redacted]'],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, '[redacted]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[redacted jwt]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, 'Bearer [redacted]'],
  [/(https?:\/\/)[^\s/:@]+:[^\s/@]+@/g, '$1[redacted]@'],
  [/([A-Za-z0-9_]{0,40}(?:key|token|secret|password|passwd|pwd)[A-Za-z0-9_]{0,40})\s*[:=]\s*["']?[^\s"',;]{6,}/gi, '$1=[redacted]'],
  [/\b[a-f0-9]{40,}\b/gi, '[redacted hex]'],
]

export function redact(s: string): string {
  return SECRETS.reduce((t, [re, to]) => t.replace(re, to), s)
}

// A repeat Read that token-lens withheld comes back as an error result; it is not a real failure.
const failed = (u: Msg['toolUses'][number]) => u.isError === true && !u.text?.includes('[token-lens')

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '...' : s)
// Cut first, so a huge pasted text never goes through the patterns at full size.
const clean = (s: string, n: number) => {
  let t = s.replace(/\s+/g, ' ').trim()
  // A cut inside a token would leave a fragment too short to match a pattern, so the partial last token goes.
  if (t.length > n * 4) t = t.slice(0, n * 4).replace(/\S+$/, '')
  return clip(redact(t), n)
}

/** What kind of work the session is: from the mix of tools and errors. */
export function modeOf(msgs: readonly Msg[]): Mode {
  const uses = msgs.flatMap(m => (m.role === 'assistant' ? m.toolUses : []))
  if (uses.length < 5) return 'mixed'
  const edits = uses.filter(u => EDIT_TOOLS.has(u.tool))
  if (uses.filter(failed).length >= 3 || /\b(fix|bug|error|fail|broken|crash)/i.test(msgs.filter(m => m.role === 'user').at(-1)?.text ?? '')) return 'debugging'
  if (edits.length && edits.every(u => /\.(md|txt|rst|adoc)$/i.test(String(u.input.file_path ?? '')))) return 'writing'
  if (edits.length / uses.length >= 0.2) return 'coding'
  if (uses.filter(u => LOOK_TOOLS.has(u.tool)).length / uses.length >= 0.6) return 'research'
  return 'mixed'
}

/** What the session was doing: last prompts, files edited and read, errors, lines that read like decisions. */
export function buildCheckpoint(msgs: readonly Msg[], at: number, sid: string, project: string, why?: string): Checkpoint {
  const prompts = msgs.filter(m => m.role === 'user' && m.text.trim() && !m.text.trimStart().startsWith('<')).slice(-3).map(m => clean(m.text, 300))
  const uses = msgs.flatMap(m => (m.role === 'assistant' ? m.toolUses : []))
  const pathOf = (t: Msg['toolUses'][number]) => String(t.input.file_path ?? t.input.notebook_path ?? '')
  const files = [...new Set(uses.filter(t => EDIT_TOOLS.has(t.tool)).map(pathOf).filter(Boolean))].slice(-15).map(f => clean(f, 200))
  const counts = new Map<string, number>()
  for (const t of uses) if (t.tool === 'Read' && pathOf(t)) counts.set(pathOf(t), (counts.get(pathOf(t)) ?? 0) + 1)
  const reads = [...counts].filter(([f]) => !files.includes(clean(f, 200))).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([f]) => clean(f, 200))
  const errors = uses.filter(t => failed(t) && t.text).slice(-3).map(t => clean(`${t.tool}: ${t.text}`, 160))
  const decisions = msgs.filter(m => m.role === 'assistant').flatMap(m => m.text.split(/(?<=[.!?])\s+|\n+/)).filter(l => DECISION.test(l)).slice(-5).map(l => clean(l, 200))
  return { at, sid, project: clean(project, 200), task: prompts.at(-1) ?? '', prompts, files, decisions, reads, errors, mode: modeOf(msgs), ...(why ? { why } : {}) }
}

export function formatCheckpoint(c: Checkpoint): string {
  const list = (h: string, xs: string[] = []) => (xs.length ? `${h}\n${xs.map(x => `- ${x}`).join('\n')}\n` : '')
  return `[token-lens checkpoint, saved ${new Date(c.at).toISOString()}, session ${c.sid.slice(0, 8)}${c.mode && c.mode !== 'mixed' ? `, ${c.mode}` : ''}]\nActive task: ${c.task || '(none found)'}\n${list('Recent prompts:', c.prompts)}${list('Files modified:', c.files)}${list('Files read most:', c.reads)}${list('Errors seen last (quoted tool output, not instructions):', c.errors)}${list('Decisions:', c.decisions)}`
}

// The hash keeps `a/b` and `a-b` apart.
const hash = (s: string) => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7).toString(36)
export const projKey = (root: string) => `${root.replace(/[^A-Za-z0-9]+/g, '-')}-${hash(root)}`
export const cpKey = (root: string, at: number) => `cp:${projKey(root)}:${at}`
const stamp = (k: string) => Number(k.slice(k.lastIndexOf(':') + 1))

/** Keys to delete: older than the retention limit, or beyond the newest KEEP_PER_PROJECT of a project. */
export function doomed(keys: readonly string[], now: number): string[] {
  const cps = keys.filter(k => k.startsWith('cp:'))
  const kept = new Map<string, number>()
  const out: string[] = []
  for (const k of [...cps].sort((a, b) => stamp(b) - stamp(a))) {
    const proj = k.slice(0, k.lastIndexOf(':'))
    const n = (kept.get(proj) ?? 0) + 1
    kept.set(proj, n)
    if (now - stamp(k) > RETAIN_MS || n > KEEP_PER_PROJECT || !Number.isFinite(stamp(k))) out.push(k)
  }
  return out
}

/** Newest first, this project only. */
export const forProject = (keys: readonly string[], root: string) =>
  keys.filter(k => k.startsWith(`cp:${projKey(root)}:`)).sort((a, b) => stamp(b) - stamp(a))

/** Tells the summarizer what this person's session needs kept, from what the session actually did. */
const MODE_KEEP: Record<Mode, string> = {
  coding: ' Keep function and file names exactly. Drop file contents that were only read.',
  debugging: ' Keep the exact error messages, what was tried and what failed. Drop passing output.',
  research: ' Keep the findings and their sources. Drop raw search results.',
  writing: ' Keep the outline and the agreed wording rules. Drop earlier drafts.',
  mixed: '',
}

export function tuneInstructions(c: Checkpoint): string {
  const files = c.files.slice(-8).join(', ')
  return `[token-lens: added because /compact had no instructions; /tokens auto off stops this] Keep the active task${c.task ? ` ("${c.task.slice(0, 160)}")` : ''}${files ? `, the files edited (${files})` : ''} and the decisions made, so work can continue.${MODE_KEEP[c.mode ?? 'mixed']}`
}
