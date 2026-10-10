// The Session tab: what this session did, from events alone. The turn, the MCP
// servers and their calls in flight, the agents as cards that open on a press,
// the permission checks, the log and the tools used. Every row is cut to the
// pane's width. Plain data in, elements out; the engine is not touched.

import type { Color, RenderElement } from 'claude-code'

import type { AgentCard, AgentStatus, GateCheck, GateVerdict, LogEntry, LogKind, McpServer, Receipt, SessionView } from '../model'
import { human } from '../statusline-format'
import {
  ago,
  bareTool,
  clean,
  clock,
  count,
  cut,
  dotted,
  fit,
  HOTKEY_CELLS,
  latency,
  layout,
  MUTED,
  shortTool,
  usd,
  type Kit,
  type Layout,
  type Part,
} from './kit'

/** What the Session tab needs besides its data: the time, the room, which card is open, and what a press on a card does. */
export type SessionOptions = {
  /** Now, as epoch ms: every clock and age counts from it. */
  nowMs: number
  /** Cells across the pane's body. */
  width: number
  /** The agent whose card is open, by id; null when every card is closed. */
  expanded: string | null
  /** Opens the card of an agent, or closes the open one with null. */
  onExpand: (agentId: string | null) => void
  /** How many log entries to draw at most; 10 when left out. */
  logRows?: number
}

const MAX_SERVERS = 8
const MAX_FLIGHTS = 3
/** A call in flight longer than this is drawn as stuck. */
const STUCK_MS = 60_000
const MAX_CARDS = 6
const MAX_CARD_TOOLS = 3
/** Rows of an agent's answer shown when its card is open. */
const ANSWER_ROWS = 3
const MAX_STRIP = 40
const MAX_DETAILS = 3
const LOG_ROWS = 10
const MAX_TOOLS = 12
const TOOL_ROWS = 4
const INDENT: Part = { text: '  ' }
/** Under the `1: ` a card's button draws. */
const CARD_INDENT: Part = { text: ' '.repeat(HOTKEY_CELLS) }
const STATUS_MARKS: Record<AgentStatus, string> = { running: '▸', done: '✓', stopped: '■', failed: '✗' }
/** Worst first, which is the order the counts read in and the reverse of the order they give way in. */
const VERDICTS: readonly { verdict: GateVerdict; words: string; color: Color; drop: number }[] = [
  { verdict: 'denied', words: 'denied', color: 'error', drop: 1 },
  { verdict: 'pending', words: 'pending', color: 'warning', drop: 2 },
  { verdict: 'asked', words: 'asked', color: 'suggestion', drop: 3 },
  { verdict: 'rule', words: 'allowed', color: 'success', drop: 4 },
]
const LOG_GLYPHS: Record<LogKind, { glyph: string; color: Color }> = {
  prompt: { glyph: '›', color: 'claude' },
  spawn: { glyph: '+', color: 'suggestion' },
  done: { glyph: '✓', color: 'success' },
  edit: { glyph: '✎', color: 'blue' },
  error: { glyph: '✗', color: 'error' },
  denied: { glyph: '⊘', color: 'error' },
  compact: { glyph: '⟲', color: 'warning' },
  git: { glyph: '⎇', color: 'magenta' },
}

function verdictOf(verdict: GateVerdict): (typeof VERDICTS)[number] {
  return VERDICTS.find(one => one.verdict === verdict) ?? { verdict, words: verdict, color: MUTED, drop: 5 }
}

// ---------------------------------------------------------------- turn

function receiptParts(receipt: Receipt, nowMs: number): Part[] {
  const head: Part = receipt.isRunning
    ? { text: `● working${receipt.startedAt > 0 ? ` ${clock(nowMs - receipt.startedAt)}` : ''}`, color: 'warning' }
    : { text: `✓ ${receipt.durationMs === null ? 'done' : clock(receipt.durationMs)}`, color: 'success' }

  return [
    head,
    ...dotted(
      [
        receipt.isRunning || receipt.costUsd === null ? null : { text: usd(receipt.costUsd), color: MUTED, drop: 4 },
        receipt.agents > 0 ? { text: count(receipt.agents, 'agent'), color: MUTED, drop: 3 } : null,
        receipt.edits > 0 ? { text: count(receipt.edits, 'edit'), color: MUTED, drop: 2 } : null,
        receipt.errors > 0 ? { text: count(receipt.errors, 'error'), color: 'error', drop: 1 } : null,
      ],
      true,
    ),
  ]
}

function turnRows(ui: Layout, receipt: Receipt | null, compactions: number, nowMs: number): RenderElement[] {
  const rows = [ui.header('Turn'), receipt === null ? ui.empty('no turn yet') : ui.line(receiptParts(receipt, nowMs))]

  if (compactions > 0) {
    rows.push(ui.line([{ text: `⟲ ${count(compactions, 'compaction')}`, color: MUTED }]))
  }

  return rows
}

// ---------------------------------------------------------------- MCP

/** One server's row, and a row under it for each call still running: in the error color once it has run past a minute. */
function serverRows(ui: Layout, server: McpServer, nowMs: number): RenderElement[] {
  const last = server.lastAt === null ? '' : ago(nowMs, server.lastAt)
  const rows = [
    ui.line([
      { text: clean(server.server), bold: true, min: 8 },
      { text: ` ${count(server.calls, 'call')}`, color: MUTED },
      ...dotted(
        [
          server.errors > 0 ? { text: count(server.errors, 'error'), color: 'error', drop: 1 } : null,
          (server.timedCalls ?? server.calls) > 0 ? { text: `avg ${latency(server.totalMs / (server.timedCalls ?? server.calls))}`, color: MUTED, drop: 3 } : null,
          server.calls > 0 ? { text: `max ${latency(server.maxMs)}`, color: MUTED, drop: 4 } : null,
          last === '' ? null : { text: `last ${last} ago`, color: MUTED, drop: 2 },
        ],
        true,
      ),
    ]),
  ]
  const flights = [...server.inFlight].sort((a, b) => a.startedAt - b.startedAt)

  for (const call of flights.slice(0, MAX_FLIGHTS)) {
    const elapsed = Math.max(0, nowMs - call.startedAt)
    const color: Color = elapsed > STUCK_MS ? 'error' : 'warning'

    rows.push(
      ui.line([
        { text: '  ▸ ', color },
        { text: clean(bareTool(call.tool)), color, min: 6 },
        { text: `  ${latency(elapsed)}`, color },
      ]),
    )
  }
  if (flights.length > MAX_FLIGHTS) {
    rows.push(ui.line([INDENT, { text: `+${flights.length - MAX_FLIGHTS} more running`, color: MUTED }]))
  }

  return rows
}

function mcpRows(ui: Layout, servers: readonly McpServer[], nowMs: number): RenderElement[] {
  const rows = [ui.header('MCP servers')]

  if (servers.length === 0) {
    rows.push(ui.empty('no MCP calls yet'))
  }
  for (const server of servers.slice(0, MAX_SERVERS)) {
    rows.push(...serverRows(ui, server, nowMs))
  }
  if (servers.length > MAX_SERVERS) {
    rows.push(ui.line([{ text: `+${servers.length - MAX_SERVERS} more`, color: MUTED }]))
  }

  return rows
}

// ---------------------------------------------------------------- agents

/** The text of a card's button: what the agent is and does, and how long it ran once it has finished; cut to `room`. */
function cardLabel(card: AgentCard, room: number): string {
  const kind = clean(card.type)
  const task = clean(card.description)
  const took = card.status === 'running' || card.endedAt === null || card.startedAt <= 0 ? '' : clock(card.endedAt - card.startedAt)
  const parts: Part[] = [
    { text: `${STATUS_MARKS[card.status]} ${kind === '' ? task || 'agent' : kind}` },
    { text: kind === '' || task === '' ? '' : ` · ${task}`, min: 10 },
    { text: took === '' ? '' : ` · ${took}` },
  ]

  return fit(parts, room)
    .map(part => part.text)
    .join('')
}

/** A running agent's figures: steps, context, output, and how long it has been going. */
function statsParts(card: AgentCard, nowMs: number): Part[] {
  const isStarted = card.steps > 0

  return dotted([
    { text: isStarted ? `steps ${card.steps}` : 'starting', color: MUTED },
    isStarted ? { text: `ctx ${human(card.contextTokens)}`, color: MUTED, drop: 2 } : null,
    isStarted ? { text: `out ${human(card.outputTokens)}`, color: MUTED, drop: 3 } : null,
    card.startedAt > 0 ? { text: clock(nowMs - card.startedAt), color: MUTED } : null,
  ])
}

function toolRow(ui: Layout, tool: AgentCard['tools'][number]): RenderElement {
  const color: Color = tool.isError ? 'error' : MUTED

  return ui.line([
    CARD_INDENT,
    { text: tool.isError ? '✗ ' : '· ', color },
    { text: shortTool(clean(tool.tool)), ...(tool.isError ? { color } : {}) },
    { text: tool.text === '' ? '' : ` ${clean(tool.text)}`, color, min: 6 },
  ])
}

/** A card: its button, a running agent's figures and last tool, and, once open, its last tools and the start of its answer. */
function cardRows(ui: Layout, card: AgentCard, position: number, opts: SessionOptions): RenderElement[] {
  const isOpen = card.id === opts.expanded
  const isRunning = card.status === 'running'
  const rows = [
    ui.button({
      key: `agent-${position}`,
      hotkey: String(position),
      label: cardLabel(card, Math.max(1, ui.room - HOTKEY_CELLS)),
      dim: !isRunning,
      onPress: () => opts.onExpand(isOpen ? null : card.id),
    }),
  ]

  if (isRunning) {
    rows.push(ui.line([CARD_INDENT, ...statsParts(card, opts.nowMs)]))
  }
  if (isOpen) {
    if (card.tools.length === 0) {
      rows.push(ui.line([CARD_INDENT, { text: 'no tool calls yet', color: MUTED }]))
    }
    rows.push(...card.tools.slice(-MAX_CARD_TOOLS).map(tool => toolRow(ui, tool)))
    if (card.answer !== '') {
      rows.push(ui.wrapped(`» ${card.answer}`, { chars: ANSWER_ROWS * Math.max(1, ui.room - HOTKEY_CELLS), indent: HOTKEY_CELLS }))
    }
  } else {
    const last = card.tools[card.tools.length - 1]

    if (isRunning && last !== undefined) {
      rows.push(toolRow(ui, last))
    }
  }

  return rows
}

function agentRows(ui: Layout, agents: readonly AgentCard[], opts: SessionOptions): RenderElement[] {
  const running = agents.filter(card => card.status === 'running').sort((a, b) => a.startedAt - b.startedAt)
  const finished = agents.filter(card => card.status !== 'running').sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt))
  const cards = [...running, ...finished]
  const tail = [running.length > 0 ? `${running.length} running` : '', finished.length > 0 ? `${finished.length} finished` : '']
  const rows = [ui.header('Agents', tail.filter(words => words !== '').join(' · '))]

  if (cards.length === 0) {
    rows.push(ui.empty('no agents yet'))
  }
  for (const [index, card] of cards.slice(0, MAX_CARDS).entries()) {
    rows.push(...cardRows(ui, card, index + 1, opts))
  }
  if (cards.length > MAX_CARDS) {
    rows.push(ui.line([{ text: `+${cards.length - MAX_CARDS} more`, color: MUTED }]))
  }

  return rows
}

// ---------------------------------------------------------------- permissions

/** One cell per check, runs of the same verdict and the same place drawn as one piece. */
function stripParts(gate: readonly GateCheck[]): Part[] {
  const parts: Part[] = []

  for (const check of gate) {
    const { color } = verdictOf(check.verdict)
    const last = parts[parts.length - 1]

    if (last !== undefined && last.color === color && last.dim === check.inSubagent) {
      last.text += '■'
    } else {
      parts.push({ text: '■', color, dim: check.inSubagent })
    }
  }

  return parts
}

function gateRows(ui: Layout, gate: readonly GateCheck[], nowMs: number): RenderElement[] {
  const rows = [ui.header('Permissions', gate.length > 0 ? count(gate.length, 'check') : '')]

  if (gate.length === 0) {
    return [...rows, ui.empty('no permission checks yet')]
  }

  const counts = VERDICTS.map(one => ({ ...one, total: gate.filter(check => check.verdict === one.verdict).length }))
    .filter(one => one.total > 0)
    .map((one, index): Part => ({ text: `${index === 0 ? '' : '  '}■ ${one.total} ${one.words}`, color: one.color, drop: one.drop }))

  rows.push(ui.line(stripParts(gate.slice(-Math.min(MAX_STRIP, ui.room)))), ui.line(counts))
  for (const check of gate.filter(one => one.verdict === 'denied' || one.verdict === 'asked').slice(-MAX_DETAILS)) {
    const { color, words } = verdictOf(check.verdict)
    const when = ago(nowMs, check.at)

    rows.push(
      ui.line([
        { text: `■ ${words} `, color },
        { text: shortTool(clean(check.tool)) },
        { text: check.detail === '' ? '' : ` ${clean(check.detail)}`, color: MUTED, min: 8 },
        { text: when === '' ? '' : ` · ${when}`, color: MUTED, drop: 1 },
      ]),
    )
  }

  return rows
}

// ---------------------------------------------------------------- log and tools

function logRows(ui: Layout, log: readonly LogEntry[], nowMs: number, rowCount: number): RenderElement[] {
  const rows = [ui.header('Log')]

  if (log.length === 0) {
    rows.push(ui.empty('nothing logged yet'))
  }
  for (const entry of log.slice(-rowCount)) {
    const { glyph, color } = LOG_GLYPHS[entry.kind]
    const who = cut(clean(entry.who), 14)

    rows.push(
      ui.line([
        { text: `${ago(nowMs, entry.at).padStart(3)} `, color: MUTED },
        { text: `${glyph} `, color },
        { text: who === '' ? '' : `${who} `, bold: true },
        { text: clean(entry.text), ...(entry.kind === 'error' ? { color: 'error' } : {}), min: 8 },
      ]),
    )
  }

  return rows
}

function toolsRows(ui: Layout, tools: SessionView['tools']): RenderElement[] {
  const rows = [ui.header('Tools')]

  if (tools.length === 0) {
    return [...rows, ui.empty('no tool calls yet')]
  }

  const top = [...tools].sort((a, b) => b.count - a.count).slice(0, MAX_TOOLS)

  return [...rows, ui.wrapped(top.map(tool => `${shortTool(clean(tool.name))} ${tool.count}`).join(' · '), { chars: ui.room * TOOL_ROWS })]
}

/**
 * The Session tab: the turn, MCP servers with their calls in flight, agent cards (a press on one opens or
 * closes it through `onExpand`), permission checks, the log and the tools used. Clocks and ages count from
 * `nowMs`, so they advance when the caller draws again.
 */
export function sessionView(kit: Kit, s: SessionView, opts: SessionOptions): RenderElement {
  const { Box } = kit
  const ui = layout(kit, opts.width)
  const sections = [
    turnRows(ui, s.receipt, s.compactions, opts.nowMs),
    mcpRows(ui, s.mcp, opts.nowMs),
    agentRows(ui, s.agents, opts),
    gateRows(ui, s.gate, opts.nowMs),
    logRows(ui, s.log, opts.nowMs, Math.max(1, Math.floor(opts.logRows ?? LOG_ROWS))),
    toolsRows(ui, s.tools),
  ]

  return (
    <Box flexDirection="column" gap={1}>
      {sections.map(rows => (
        <Box flexDirection="column">{rows}</Box>
      ))}
    </Box>
  )
}
