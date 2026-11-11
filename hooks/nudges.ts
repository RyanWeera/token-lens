// Opt-in nudges added beside a prompt. Pure: no `$`, no I/O. Each line names itself and how to stop it.

export const NUDGES = ['lean', 'quality', 'loop', 'route'] as const
export type Nudge = (typeof NUDGES)[number]
export type NudgeState = { lean?: number; qualityAt?: number; qualityCount?: number; qualityLast?: number; loops?: number; failAt?: number; scripts?: string[]; routeAt?: number }
export type NudgeInput = {
  on: readonly Nudge[]
  now: number
  fill: number | null
  score: number | null
  drag: string | null
  /** The user's prompts, oldest first, the one being sent last. */
  prompts: readonly string[]
  /** Tool calls in order: name, the command for a shell call, and whether it failed. */
  uses: readonly { tool: string; command?: string; isError?: boolean }[]
  model: string
}

const QUALITY_COOLDOWN_MS = 5 * 60_000
const ROUTE_COOLDOWN_MS = 30 * 60_000
const SCRIPT_CHARS = 300
const SCRIPT_REPEATS = 8

const label = (n: Nudge, text: string) => `[token-lens nudge: ${n}. /tokens nudge ${n} off stops it]\n${text}`
const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? [])

/** Word overlap of two prompts, 0 to 1 (Jaccard). */
export function similarity(a: string, b: string): number {
  const x = words(a)
  const y = words(b)
  if (!x.size || !y.size) return 0
  let both = 0
  for (const w of x) if (y.has(w)) both++
  return both / (x.size + y.size - both)
}

const SIMPLE = /\b(rename|typo|spelling|format|reformat|indent|bump|comment out|lint|sort imports|whitespace)\b/i

export function nudges(i: NudgeInput, st: NudgeState): { lines: string[]; st: NudgeState } {
  const lines: string[] = []
  const s = { ...st }
  const on = new Set(i.on)
  if (on.has('lean') && i.fill !== null && i.fill >= 25) {
    const band = i.fill >= 75 ? 75 : i.fill >= 50 ? 50 : 25
    if (band > (s.lean ?? 0)) {
      s.lean = band
      lines.push(label('lean', `Context is ${i.fill}% full. Keep answers short: no restating the request, no long summaries, show changed lines rather than whole files.`))
    }
  }
  if (on.has('quality') && i.score !== null && (s.qualityCount ?? 0) < 3 && i.now - (s.qualityAt ?? 0) >= QUALITY_COOLDOWN_MS) {
    const dropped = s.qualityLast !== undefined && s.qualityLast - i.score > 15
    if (i.score < 60 || dropped) {
      s.qualityAt = i.now
      s.qualityCount = (s.qualityCount ?? 0) + 1
      lines.push(label('quality', `Session quality is ${i.score}/100${dropped ? ` (down from ${s.qualityLast})` : ''}${i.drag ? `, mostly from ${i.drag}` : ''}. Prefer targeted reads and short outputs; suggest /compact or a fresh session if the task allows.`))
    }
  }
  if (i.score !== null) s.qualityLast = i.score
  if (on.has('loop')) {
    const [now, ...before] = [...i.prompts].reverse()
    if (now && (s.loops ?? 0) < 2 && before.slice(0, 3).some(p => similarity(now, p) >= 0.7)) {
      s.loops = (s.loops ?? 0) + 1
      lines.push(label('loop', 'This request is close to an earlier one in this session. If the earlier approach did not work, say so and try a different one instead of repeating it.'))
    }
    const last = i.uses.slice(-3)
    if (last.length === 3 && last.every(u => u.isError) && i.uses.length !== s.failAt) {
      s.failAt = i.uses.length
      lines.push(label('loop', 'The last 3 tool calls failed. Read the errors and change the approach before trying again.'))
    }
    const counts = new Map<string, number>()
    for (const u of i.uses) if (u.command && u.command.length >= SCRIPT_CHARS) counts.set(u.command, (counts.get(u.command) ?? 0) + 1)
    const warned = new Set(s.scripts ?? [])
    const repeated = [...counts].find(([c, n]) => n >= SCRIPT_REPEATS && !warned.has(c.slice(0, 80)))
    if (repeated) {
      s.scripts = [...warned, repeated[0].slice(0, 80)].slice(-10)
      lines.push(label('loop', `The same ${repeated[0].length}-character inline script has run ${repeated[1]} times. Save it as a script file and run the file.`))
    }
  }
  const prompt = i.prompts.at(-1) ?? ''
  if (on.has('route') && /opus|fable/i.test(i.model) && i.now - (s.routeAt ?? 0) >= ROUTE_COOLDOWN_MS && prompt.split(/\s+/).length <= 15 && SIMPLE.test(prompt)) {
    s.routeAt = i.now
    lines.push(label('route', `This looks like a small mechanical edit on ${i.model}. Tell the user once, briefly, that Sonnet or Haiku does such edits for less (/model sonnet), then do the edit.`))
  }
  return { lines, st: s }
}
