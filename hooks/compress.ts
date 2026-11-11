// Tool output compression. Pure: no `$`, no I/O.
// Every change is labelled in the text the model reads, names the id that gets the full text back, and how to stop it.

export const EXPAND = 'mcp__token-lens__expand'
export const ARCHIVE_AT = 8_000 // chars: a longer output is cut to KEEP and archived whole
const KEEP = 4_000
export const REREAD_WINDOW_MS = 30 * 60_000 // an earlier read older than this may have left the context
const OUTLINE_MIN = 2_000 // a smaller re-read is not worth an outline

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g

/** Colour codes out, progress redraws down to their last frame, runs of 3 or more identical lines folded. */
export function fold(text: string): string {
  const lines = text.replace(ANSI, '').split('\n').map(l => (l.includes('\r') ? (l.split('\r').filter(Boolean).pop() ?? '') : l))
  const out: string[] = []
  for (let i = 0; i < lines.length; ) {
    let j = i
    while (j + 1 < lines.length && lines[j + 1] === lines[i]) j++
    const n = j - i + 1
    if (n < 3) out.push(...lines.slice(i, j + 1))
    else if (!lines[i].trim()) out.push('')
    else out.push(lines[i], `[token-lens: the line above repeats ${n - 1} more times]`)
    i = j + 1
  }
  return out.join('\n')
}

// A slice ends on a line break when one is near, so no line is cut in half.
const headOf = (t: string, n: number) => { const s = t.slice(0, n); const i = s.lastIndexOf('\n'); return i > n / 2 ? s.slice(0, i + 1) : s }
const tailOf = (t: string, n: number) => { const s = t.slice(-n); const i = s.indexOf('\n'); return i >= 0 && i < n / 2 ? s.slice(i + 1) : s }

/** Keeps the start and the end, with a labelled gap that names the archive id. */
export function cut(text: string, id: string, keep = KEEP): string {
  if (text.length <= keep) return text
  const head = headOf(text, Math.floor(keep * 0.6))
  const tail = tailOf(text, Math.floor(keep * 0.4))
  const middle = text.slice(head.length, text.length - tail.length)
  const lines = middle.split('\n').length
  return `${head}\n[token-lens: ${lines} lines (${middle.length} chars) folded here. Full output: call ${EXPAND} with id "${id}". /tokens compress off stops this]\n${tail}`
}

/** Bash or search output: folded, then cut when still long. Null when it would save too little to be worth a label. */
export function compress(text: string, id: string): { text: string; archived: boolean } | null {
  const folded = fold(text)
  const archived = folded.length > ARCHIVE_AT
  const out = archived ? cut(folded, id) : `${folded}\n[token-lens: colour codes and progress redraws removed, repeated lines folded. /tokens compress off stops this]`
  return text.length - out.length >= Math.max(300, text.length * 0.1) ? { text: out, archived } : null
}

const DECL = /^\s*(?:(?:export|public|private|protected|static|async|pub|default|abstract)\s+)*(?:function|class|interface|type|enum|const|let|var|def|fn|struct|impl|trait|module|namespace|func|object)\b|^#{1,6}\s/

/** Declaration and heading lines, with their line numbers. */
export function outline(content: string, startLine = 1, max = 40): string[] {
  return content.split('\n').map((l, i) => ({ l, n: startLine + i })).filter(x => DECL.test(x.l)).slice(0, max).map(x => `  ${x.n}: ${x.l.trim().slice(0, 140)}`)
}

export type Seen = { at: number; content: string }

/**
 * A repeat Read of the same range in this conversation: an outline when the file is unchanged, the changed
 * lines alone when a small part changed. Null when the full text should go through (first read, older than
 * the window, small, or mostly changed).
 */
export function reread(prev: Seen | undefined, content: string, startLine: number, now: number, id: string): string | null {
  if (!prev || now - prev.at > REREAD_WINDOW_MS || content.length < OUTLINE_MIN) return null
  const mins = Math.max(1, Math.round((now - prev.at) / 60_000))
  const back = `[Full text again: call ${EXPAND} with id "${id}". /tokens compress read off stops this]`
  if (prev.content === content) {
    const o = outline(content, startLine)
    return [`[token-lens: this range is unchanged since you read it ${mins} min ago; that copy is still above in this conversation.${o.length ? ' Outline (line: text):' : ''}]`, ...o, back].join('\n')
  }
  const a = prev.content.split('\n')
  const b = content.split('\n')
  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
  let suf = 0
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++
  const changed = b.slice(pre, b.length - suf)
  const removed = a.length - pre - suf
  if (b.length < 80 || changed.length > b.length * 0.4) return null
  const first = startLine + pre
  return [
    `[token-lens: changed since you read it ${mins} min ago. Lines before ${first} and the last ${suf} lines are unchanged and still above in this conversation.`,
    changed.length ? `Lines ${first}-${first + changed.length - 1} now read (line: text), replacing ${removed} old line(s):]` : `${removed} line(s) at line ${first} were deleted.]`,
    ...changed.map((l, i) => `  ${first + i}: ${l}`),
    back,
  ].join('\n')
}
