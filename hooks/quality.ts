// Live session quality, S to F, from the conversation and the context fill. Pure: no `$`, no I/O.
// Seven signals. Resource health: context fill, compactions, wasted tokens.
// Efficiency: stale reads, bloated results, decision density, subagent report size.

import { DECISION } from './checkpoint'

export type Use = { tool: string; input: Record<string, unknown>; text?: string; isError?: true }
export type Turn = { role: 'user' | 'assistant'; text: string; toolUses: readonly Use[] }

type Part = { score: number; estimated_waste_tokens: number }
export type Quality = {
  score: number
  grade: string
  resource_health: number
  resource_health_grade: string
  efficiency: number
  efficiency_grade: string
  breakdown: Record<string, Part>
  top_drag: { key: string; label: string } | null
  tool_calls: number
  compactions: number
  fill_pct: number | null
}

export const BLOAT_CHARS = 8_000
const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const tok = (chars: number) => Math.round(chars / 4)
const clamp = (x: number) => Math.max(0, Math.min(100, Math.round(x)))
const fromWaste = (tokens: number, zeroAt: number) => clamp(100 - (100 * tokens) / zeroAt)

export const gradeOf = (s: number) => (s >= 90 ? 'S' : s >= 80 ? 'A' : s >= 70 ? 'B' : s >= 55 ? 'C' : s >= 40 ? 'D' : 'F')

const LABELS: Record<string, string> = {
  context_fill: 'context fill',
  compactions: 'compactions',
  stale_reads: 'stale file reads',
  bloated_results: 'bloated tool results',
  reread_loops: 'files re-read in loops',
  decision_density: 'few edits or decisions per tool call',
  agent_reports: 'long subagent reports',
}
// Each signal's share of the final score: health is 60%, efficiency 40%.
const WEIGHT: Record<string, number> = { context_fill: 0.3, compactions: 0.15, waste: 0.15, stale_reads: 0.08, bloated_results: 0.08, reread_loops: 0.08, decision_density: 0.08, agent_reports: 0.08 }

export function quality(turns: readonly Turn[], fill: number | null, compactions: number): Quality {
  const uses = turns.flatMap(t => (t.role === 'assistant' ? t.toolUses : []))
  // Every copy of a file but the last one read is dead weight: twice is a stale read, three times or more a loop.
  const reads = new Map<string, number[]>()
  for (const u of uses) {
    if (u.tool !== 'Read' || u.isError) continue
    const p = String(u.input.file_path ?? '')
    reads.set(p, [...(reads.get(p) ?? []), tok(u.text?.length ?? 0)])
  }
  let stale = 0
  let loops = 0
  for (const sizes of reads.values()) {
    const dead = sizes.slice(0, -1).reduce((a, b) => a + b, 0)
    if (sizes.length === 2) stale += dead
    else if (sizes.length > 2) loops += dead
  }
  const bloat = uses.reduce((s, u) => s + tok(Math.max(0, (u.text?.length ?? 0) - BLOAT_CHARS)), 0)
  const edits = uses.filter(u => EDITS.has(u.tool) && !u.isError).length
  const decisions = turns.filter(t => t.role === 'assistant').flatMap(t => t.text.split(/(?<=[.!?])\s+|\n+/)).filter(l => DECISION.test(l)).length
  const agents = uses.filter(u => u.tool === 'Agent' || u.tool === 'Task').map(u => u.text?.length ?? 0)
  const avgAgent = agents.length ? agents.reduce((a, b) => a + b, 0) / agents.length : 0

  const parts: Record<string, Part> = {
    context_fill: { score: fill === null ? 100 : clamp(100 - (Math.max(0, fill - 20) * 100) / 75), estimated_waste_tokens: 0 },
    compactions: { score: clamp(100 - 20 * compactions), estimated_waste_tokens: 0 },
    stale_reads: { score: fromWaste(stale, 40_000), estimated_waste_tokens: stale },
    bloated_results: { score: fromWaste(bloat, 40_000), estimated_waste_tokens: bloat },
    reread_loops: { score: fromWaste(loops, 40_000), estimated_waste_tokens: loops },
    // Under 10 tool calls there is too little to judge.
    decision_density: { score: uses.length < 10 ? 100 : clamp(40 + ((edits + decisions) / uses.length) * 400), estimated_waste_tokens: 0 },
    agent_reports: { score: clamp(100 - Math.max(0, avgAgent - 3_000) / 150), estimated_waste_tokens: 0 },
  }
  const wasteScore = fromWaste(stale + bloat + loops, 60_000)
  const health = clamp(0.5 * parts.context_fill.score + 0.25 * parts.compactions.score + 0.25 * wasteScore)
  const eff = clamp(['stale_reads', 'bloated_results', 'reread_loops', 'decision_density', 'agent_reports'].reduce((s, k) => s + parts[k].score, 0) / 5)
  const score = clamp(0.6 * health + 0.4 * eff)

  // The drag is the signal that costs the most points; the waste share goes to its biggest part.
  const biggestWaste = (['stale_reads', 'bloated_results', 'reread_loops'] as const).reduce((a, b) => (parts[b].estimated_waste_tokens > parts[a].estimated_waste_tokens ? b : a))
  const lost = Object.keys(LABELS).map(k => ({ k, pts: (100 - parts[k].score) * WEIGHT[k] + (k === biggestWaste ? (100 - wasteScore) * WEIGHT.waste : 0) }))
  const worst = lost.reduce((a, b) => (b.pts > a.pts ? b : a))
  return {
    score,
    grade: gradeOf(score),
    resource_health: health,
    resource_health_grade: gradeOf(health),
    efficiency: eff,
    efficiency_grade: gradeOf(eff),
    breakdown: parts,
    top_drag: worst.pts >= 2 ? { key: worst.k, label: LABELS[worst.k] } : null,
    tool_calls: uses.length,
    compactions,
    fill_pct: fill,
  }
}

export function formatQuality(q: Quality): string {
  const rows = Object.entries(q.breakdown).map(([k, p]) => `  ${LABELS[k].padEnd(38)} ${String(p.score).padStart(3)}/100${p.estimated_waste_tokens ? `  (~${p.estimated_waste_tokens} tokens of waste)` : ''}`)
  return [
    `Session quality: ${q.score}/100 (${q.grade}). Resource health ${q.resource_health} (${q.resource_health_grade}), efficiency ${q.efficiency} (${q.efficiency_grade}).`,
    `Context ${q.fill_pct === null ? 'fill unknown' : `${q.fill_pct}% full`}, ${q.compactions} compaction(s), ${q.tool_calls} tool calls.`,
    q.top_drag ? `Main drag: ${q.top_drag.label}.` : 'Nothing drags it down.',
    'Signals:',
    ...rows,
    'Grades: S 90+, A 80+, B 70+, C 55+, D 40+, F below 40.',
  ].join('\n')
}

type Breakdown = {
  categories: { name: string; tokens: number; isDeferred: boolean }[]
  totalTokens: number
  rawMaxTokens: number
  percentage: number
  memoryFiles: { path: string; tokens: number }[]
  mcpTools: { name: string; serverName: string; tokens: number; isLoaded: boolean }[]
  agents: { agentType: string; tokens: number }[]
}

/** /tokens report: the live context by part, the way /context counts it. */
export function formatBreakdown(b: Breakdown): string {
  const n = (x: number) => (x >= 1000 ? `${(x / 1000).toFixed(1)}k` : String(x))
  const top = <T,>(xs: T[], size: (x: T) => number, k = 8) => [...xs].sort((a, c) => size(c) - size(a)).slice(0, k)
  const servers = new Map<string, number>()
  for (const t of b.mcpTools) if (t.isLoaded) servers.set(t.serverName, (servers.get(t.serverName) ?? 0) + t.tokens)
  return [
    `Context: ${n(b.totalTokens)} of ${n(b.rawMaxTokens)} tokens (${b.percentage}%). Estimated locally, as /context counts it.`,
    '',
    'By part:',
    ...top(b.categories.filter(c => !c.isDeferred && c.tokens > 0), c => c.tokens, 20).map(c => `  ${c.name.padEnd(30)} ${n(c.tokens).padStart(7)}`),
    ...(b.memoryFiles.length ? ['', 'Memory and CLAUDE.md files:', ...top(b.memoryFiles, f => f.tokens).map(f => `  ${n(f.tokens).padStart(7)}  ${f.path}`)] : []),
    ...(servers.size ? ['', 'MCP servers (loaded tool schemas):', ...top([...servers], s => s[1]).map(([s, t]) => `  ${n(t).padStart(7)}  ${s}`)] : []),
    ...(b.agents.length ? ['', 'Agent descriptions:', ...top(b.agents, a => a.tokens, 5).map(a => `  ${n(a.tokens).padStart(7)}  ${a.agentType}`)] : []),
  ].join('\n')
}
