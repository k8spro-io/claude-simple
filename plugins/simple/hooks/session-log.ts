// The Session tab's tracker: a reducer the hooks module feeds from the
// engine's events (tool checks and calls, agent spawns and steps, turns,
// compactions). It keeps what the tab draws as plain data: the MCP servers
// with their timings and the calls in flight, a card per subagent, the
// permission gate, a short log and the last turn's receipt. Nothing here
// takes the engine's `$` or reads the clock: time comes in as epoch ms, so a
// test replays a session exactly.

import type { AgentCard, GateCheck, LogEntry, LogKind, McpServer, Receipt, SessionView } from './model'

/** What `tool.check` decided: run the tool, put it to the person (or the auto-mode classifier), or refuse it. */
export type Decision = 'allow' | 'ask' | 'deny'

/** What one model request used, as the engine's `TurnUsage` reports it; a count left out reads as zero. */
export type StepUsage = {
  input_tokens?: number | null
  output_tokens?: number | null
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
}

/** A tool call begins (`tool.call`, before it runs). `input` is accepted as the other tool events carry it; the tally does not read it. */
export type ToolStarted = {
  /** The call's `tool_use_id`. */
  id: string
  tool: string
  /** The subagent the call runs in; left out on the main loop. */
  agentId?: string | undefined
  input?: unknown
  nowMs: number
}

/** A call's permission check (`tool.check` on a real call, with its verdict). */
export type ToolChecked = {
  id: string
  tool: string
  input?: unknown
  decision: Decision
  agentId?: string | undefined
  nowMs: number
}

/** A call settles (`tool.call` resolved). `isError` is the tool's own failure, `isDenied` a refusal (the call did not run). */
export type ToolFinished = {
  id: string
  tool: string
  agentId?: string | undefined
  input?: unknown
  isError?: boolean
  isDenied?: boolean
  /** The tool's record; a Bash result's `gitOperation` becomes log entries. */
  result?: unknown
  nowMs: number
}

/** A subagent started (`agent.spawn` resolved with its id). */
export type AgentSpawned = {
  /** The started agent's id: the `agentId` its own events carry. */
  id: string
  type: string
  description: string
  model: string
  nowMs: number
}

/** One model request of a subagent finished (`turn.step` resolved). */
export type AgentStepped = {
  agentId: string
  usage?: StepUsage | null | undefined
  stopReason?: string | null | undefined
  nowMs: number
}

/** A main-loop turn begins (`turn.start`). */
export type TurnStarted = {
  /** The prompt; "" for a turn started without one. */
  text: string
  nowMs: number
  /** The session's cost in dollars now, when known. */
  costUsd?: number | null | undefined
}

/** A turn ends (`turn.complete`): the main loop's when `agentId` is left out, else that subagent's run. */
export type TurnCompleted = {
  agentId?: string | undefined
  /** 'answer', 'aborted', 'refusal' or 'error'. */
  reason: string
  answer: string
  /** The turn's wall-clock length, as the event reports it. */
  durationMs: number
  /** The session's cost in dollars now, when known. */
  costUsd?: number | null | undefined
  nowMs: number
}

/** A compaction happened (`session.compact` answered with a compacted conversation). */
export type Compacted = {
  /** 'manual', 'auto' or 'plugin'; 'precompute' installs nothing and is not counted. */
  trigger: string
  nowMs: number
}

const MAX_AGENTS = 24
const MAX_GATE = 60
const MAX_LOG = 200
/** MCP durations waiting for their call, and calls waiting for their duration, at most. */
const MAX_SETTLED = 100
const CARD_TOOLS = 3
const DETAIL_CHARS = 120
const CARD_TOOL_CHARS = 64
const LOG_CHARS = 160
const WHO_CHARS = 14
const ANSWER_CHARS = 400
const MASK_CHARS = 200
/** How much text the masking rules read; they never need more than what could be shown. */
const READ_CHARS = 8000
/** An MCP argument that is "short" enough to say what the call was about. */
const SHORT_ARG_CHARS = 80
const MASK = '•••'
const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'NotebookEdit', 'Glob', 'Grep'])
const SHELL_TOOLS = new Set(['Bash', 'PowerShell', 'Monitor'])
const WEB_TOOLS = new Set(['WebFetch', 'WebSearch'])
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])
/** Where an unlisted tool keeps what it is about, in the order to look. */
const ABOUT_KEYS = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'subject', 'prompt', 'name']

// -------------------------------------------------------------------- masking

/** The names a value is kept under when it is a secret: `password=`, `GITHUB_TOKEN=`, `"api_key":`. */
const SECRET_NAME = String.raw`(?:password|passwd|passphrase|pwd|secret|secret[_-]?key|token|api[_-]?key|access[_-]?key|private[_-]?key)`

/** Applied in order; the later rules never see what an earlier one hid. */
const SECRET_RULES: readonly (readonly [RegExp, string])[] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, MASK],
  [/\b(authorization["']?\s*[:=]\s*["']?)(?:(?:bearer|basic|digest|token)\s+)?[^\s"']+/gi, `$1${MASK}`],
  [/\b(bearer)\s+[\w.~+/=-]+/gi, `$1 ${MASK}`],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,})/g, MASK],
  [/\bsk[-_][A-Za-z0-9_-]{8,}/g, MASK],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, MASK],
  [/\bxox[abprs]-[A-Za-z0-9-]{8,}/g, MASK],
  [/\bglpat-[A-Za-z0-9_-]{16,}/g, MASK],
  [/\bnpm_[A-Za-z0-9]{20,}/g, MASK],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, MASK],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, MASK],
  // user:password@ inside a URL
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s@/]+@/gi, `$1${MASK}@`],
  // password=..., "token": "...", GITHUB_TOKEN=..., --api-key=...
  [new RegExp(String.raw`(\b[\w-]{0,40}?${SECRET_NAME}["']?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s&,;"']+)`, 'gi'), `$1${MASK}`],
  // --token abc, --password abc
  [/(--[\w-]*(?:token|password|passwd|secret|api-?key)\s+)(?!-)("[^"]*"|'[^']*'|\S+)/gi, `$1${MASK}`],
  // curl -u user:password, --user user:password
  [/((?:^|\s)(?:-u|--user)[=\s]+["']?[^\s:"']+:)[^\s"']+/g, `$1${MASK}`],
  // mysql -ppassword (the value glued to the flag)
  [/(\b(?:mysql|mysqldump|mariadb)\b[^\n]*?\s-p)(?=[^\s-])\S+/gi, `$1${MASK}`],
]

/** Runs of letters and digits that random keys are made of, and little else is: URL-safe base64 as well as hex. */
const HEX_RUN = /\b[0-9a-f]{33,}\b/gi
const KEY_RUN = /[A-Za-z0-9+/_-]{33,}={0,2}/g

/** Terminal escape sequences, whole (CSI and OSC, 7-bit and 8-bit), so what they carried leaves no stray letters. */
const ESCAPES = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u009b[0-?]*[ -/]*[@-~]/g
/** Controls but tabs and line breaks, and the bidi and zero-width marks: unseen, one could split a secret the rules would catch. */
const INVISIBLE = /[\u0000-\u0008\u000e-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g

/**
 * A long run reads as a key when it mixes upper case, lower case and digits,
 * has few separators, and switches between letters' cases and digits every
 * couple of characters. Paths and branch names have separators; camelCase
 * names hold longer runs of one kind (`DashboardWidgetContainer2`); keys do not.
 */
function looksRandom(run: string): boolean {
  const body = run.replace(/=+$/, '')
  const separators = body.replace(/[A-Za-z0-9]/g, '').length
  const pieces = body.match(/[A-Z]+|[a-z]+|[0-9]+/g) ?? []
  const letters = pieces.reduce((sum, piece) => sum + piece.length, 0)

  return (
    /[a-z]/.test(body) &&
    /[A-Z]/.test(body) &&
    /\d/.test(body) &&
    separators * 8 <= body.length &&
    letters / Math.max(1, pieces.length) < 2.75
  )
}

function redact(text: string): string {
  let hidden = (text.length > READ_CHARS ? text.slice(0, READ_CHARS) : text).replace(ESCAPES, '').replace(INVISIBLE, '')

  for (const [rule, to] of SECRET_RULES) {
    hidden = hidden.replace(rule, to)
  }

  return hidden.replace(HEX_RUN, MASK).replace(KEY_RUN, run => (looksRandom(run) ? MASK : run))
}

/** At most `limit` characters, ending in an ellipsis when cut; never splits a surrogate pair. */
function cut(text: string, limit: number): string {
  if (text.length <= limit) {
    return text
  }

  let end = Math.max(0, limit - 1)
  const last = text.charCodeAt(end - 1)

  if (last >= 0xd800 && last <= 0xdbff) {
    end -= 1
  }

  return `${text.slice(0, end).trimEnd()}…`
}

/**
 * Hides what looks like a secret and cuts the text to `limit` characters
 * (200 by default): GitHub (ghp_, gho_, github_pat_), sk- and AWS (AKIA) keys,
 * Slack, npm and Google tokens, JWTs, private key blocks, `Bearer` and
 * `Authorization` values, `user:password@` in a URL, the value of
 * password=, token=, secret= or api_key= (also GITHUB_TOKEN=, --api-key=,
 * "token": "..."), GitLab tokens, curl's `-u user:password`, mysql's
 * `-ppassword`, hex runs over 32 characters, and longer runs that read as
 * random (mixed case and digits, switching every couple of characters; a
 * path or a camelCase name does not). Masks before it
 * cuts, so a secret on the edge never survives as a stub, and drops escape
 * sequences, control characters (tabs and line breaks stay) and invisible
 * marks first, so none can split a secret.
 */
export function mask(text: string, limit = MASK_CHARS): string {
  return limit < 1 ? '' : cut(redact(text), limit)
}

/** One line, masked and cut: how anything shown in the tab is stored. */
function brief(text: string, limit: number): string {
  return cut(redact(text).replace(/\s+/g, ' ').trim(), limit)
}

// -------------------------------------------------------------------- reading input

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** A token count: a finite number above zero, else zero. */
function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function known(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** The first of `keys` that holds a non-empty string. */
function pick(args: Readonly<Record<string, unknown>>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = text(args[key])

    if (value !== '') {
      return value
    }
  }

  return ''
}

/** An argument kept under a secret's name: shown without its name, its value would pass every rule. */
const SECRET_ARG = new RegExp(String.raw`${SECRET_NAME}|authorization|credential|cookie`, 'i')

/** The first short string argument, else the first string of any length; never one kept under a secret's name. */
function firstShortString(args: Readonly<Record<string, unknown>>): string {
  const strings = Object.entries(args)
    .filter(([key]) => !SECRET_ARG.test(key))
    .map(([, value]) => value)
    .filter((value): value is string => typeof value === 'string' && value !== '')

  return strings.find(value => value.length <= SHORT_ARG_CHARS) ?? strings[0] ?? ''
}

/** `mcp__<server>__<tool>` -> its server and tool; null for any other tool. */
function mcpParts(tool: string): { server: string; tool: string } | null {
  const match = /^mcp__(.+?)__(.+)$/.exec(tool)
  const server = match?.[1]
  const name = match?.[2]

  return server === undefined || name === undefined ? null : { server, tool: name }
}

function familyOf(tool: string): GateCheck['family'] {
  if (FILE_TOOLS.has(tool)) {
    return 'file'
  }
  if (SHELL_TOOLS.has(tool)) {
    return 'shell'
  }
  if (WEB_TOOLS.has(tool)) {
    return 'web'
  }

  return tool.startsWith('mcp__') ? 'mcp' : 'other'
}

function aboutOf(tool: string, args: Readonly<Record<string, unknown>>): string {
  if (tool === 'Bash' || tool === 'PowerShell') {
    return pick(args, ['command'])
  }
  if (tool === 'Monitor') {
    return pick(args, ['command']) || text(record(args.ws).url) || pick(args, ['description'])
  }
  if (tool === 'Read' || tool === 'Edit' || tool === 'Write') {
    return pick(args, ['file_path', 'path'])
  }
  if (tool === 'NotebookEdit') {
    return pick(args, ['notebook_path', 'file_path'])
  }
  if (tool === 'Glob' || tool === 'Grep') {
    const pattern = pick(args, ['pattern'])
    const path = pick(args, ['path'])

    return pattern === '' || path === '' ? pattern || path : `${pattern} in ${path}`
  }
  if (tool === 'WebFetch') {
    return pick(args, ['url'])
  }
  if (tool === 'WebSearch') {
    return pick(args, ['query'])
  }
  if (tool.startsWith('mcp__')) {
    return firstShortString(args)
  }

  return pick(args, ABOUT_KEYS) || firstShortString(args)
}

/**
 * One line saying what a call is about, masked and cut to 120 characters: a
 * shell command, the path of a file tool, the URL or query of a web tool, the
 * first short string argument of an MCP tool, else the call's description.
 * An argument kept under a secret's name (password, token, api_key) is never
 * the one shown. Empty when the input says nothing.
 */
export function describeInput(tool: string, input: unknown): string {
  return brief(aboutOf(tool, record(input)), DETAIL_CHARS)
}

/** What a call was, for the log: `Edit /repo/a.ts`, `docs/search how to mount`. */
function subjectOf(tool: string, input: unknown): string {
  const parts = mcpParts(tool)
  const name = parts === null ? tool : `${parts.server}/${parts.tool}`
  const detail = describeInput(tool, input)

  return detail === '' ? name : `${name} ${detail}`
}

/** What a Bash result's `gitOperation` says happened, as log lines: a commit, a merge or rebase, a push, a pull request. */
function gitNotes(result: unknown): string[] {
  const operation = record(record(result).gitOperation)
  const notes: string[] = []
  const commit = record(operation.commit)
  const sha = text(commit.sha)
  const ref = text(record(operation.branch).ref)
  const pushed = text(record(operation.push).branch)
  const pr = record(operation.pr)

  if (sha !== '') {
    notes.push(`${text(commit.kind) || 'committed'} ${sha.slice(0, 7)}`)
  }
  if (ref !== '') {
    const action = text(record(operation.branch).action)

    notes.push(action === 'rebased' ? `rebased onto ${ref}` : `${action || 'merged'} ${ref}`)
  }
  if (pushed !== '') {
    notes.push(`pushed ${pushed}`)
  }
  if (typeof pr.number === 'number' && Number.isFinite(pr.number)) {
    const action = text(pr.action).replace(/-/g, ' ')

    notes.push(`PR #${pr.number}${action === '' ? '' : ` ${action}`}`)
  }

  return notes
}

/**
 * The first line of a prompt, and who said it: the person, or the engine when
 * it opened the turn itself with a tagged message (`<agent-message ...>`,
 * `<task-notification>`). Null for a prompt with no text.
 */
function promptOf(prompt: string): { who: string; line: string } | null {
  const first = prompt
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(line => line !== '')

  if (first === undefined) {
    return null
  }

  const tag = /^<([a-z][a-z0-9]*(?:-[a-z0-9]+)+)/i.exec(first)?.[1]

  if (tag === undefined) {
    return { who: 'you', line: first }
  }

  const from = /\bfrom="([^"]+)"/.exec(first)?.[1]

  return { who: 'engine', line: `${tag.replace(/-/g, ' ')}${from === undefined ? '' : ` from ${from.slice(0, 8)}`}` }
}

/** 12 s -> "12s", 65 s -> "1m05s", 3720 s -> "1h02m". */
function took(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))

  if (seconds < 60) {
    return `${seconds}s`
  }

  const minutes = Math.floor(seconds / 60)

  return minutes < 60
    ? `${minutes}m${String(seconds % 60).padStart(2, '0')}s`
    : `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`
}

/** Dollars a turn added, when the session's cost is known at both ends and did not go down. */
function costOf(atStart: number | null, atEnd: number | null): number | null {
  return atStart === null || atEnd === null || atEnd < atStart ? null : Math.round((atEnd - atStart) * 1e6) / 1e6
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

// -------------------------------------------------------------------- the tracker

/** A subagent that ended before the card for it was made: the end waits for its spawn. */
type EarlyEnd = { reason: string; answer: string; at: number }

/**
 * A session's tracker, empty. The hooks module calls one method per engine
 * event (`toolStarted`, `toolChecked`, `toolFinished`, `agentSpawned`,
 * `agentStepped`, `turnStarted`, `turnCompleted`, `compacted`), `reset` on
 * /clear, and draws from `view`. Each call carries the clock reading as `nowMs`.
 */
export function createSessionLog() {
  const toolCounts = new Map<string, number>()
  const servers = new Map<string, McpServer>()
  /** Oldest spawn first. */
  const agents: AgentCard[] = []
  const early = new Map<string, EarlyEnd>()
  const gate: GateCheck[] = []
  const log: LogEntry[] = []
  let receipt: Receipt | null = null
  let costAtStart: number | null = null
  let compactions = 0
  /** MCP calls' own durations (classic PostToolUse) that arrived before the call settled. */
  const durations = new Map<string, number>()
  /** MCP calls that settled on wall time, kept until their own duration arrives. */
  const settled = new Map<string, { server: string; ms: number }>()
  /** Per MCP server, the longest call whose time no duration will change any more. */
  const longest = new Map<string, number>()
  /** Per MCP server, the call that settled last. */
  const latest = new Map<string, string>()

  function keepLongest(server: string, ms: number): void {
    longest.set(server, Math.max(longest.get(server) ?? 0, ms))
  }

  function say(kind: LogKind, who: string, line: string, agentId: string | undefined, at: number): void {
    log.push({ at, kind, who, text: brief(line, LOG_CHARS), agentId: agentId ?? null })
    if (log.length > MAX_LOG) {
      log.splice(0, log.length - MAX_LOG)
    }
  }

  function cardOf(agentId: string | undefined): AgentCard | undefined {
    return agentId === undefined ? undefined : agents.find(card => card.id === agentId)
  }

  function whoIs(agentId: string | undefined): string {
    if (agentId === undefined) {
      return 'main'
    }

    const card = cardOf(agentId)

    return card === undefined ? 'agent' : brief(card.description || card.type, WHO_CHARS)
  }

  function serverOf(name: string): McpServer {
    const found = servers.get(name)

    if (found !== undefined) {
      return found
    }

    const fresh: McpServer = {
      server: name,
      calls: 0,
      timedCalls: 0,
      errors: 0,
      subagentCalls: 0,
      totalMs: 0,
      maxMs: 0,
      lastMs: null,
      lastTool: '',
      lastAt: null,
      inFlight: [],
    }

    servers.set(name, fresh)

    return fresh
  }

  /** Makes room for a new card: the card that finished longest ago goes first, the oldest running one only when none has finished. */
  function evictAgent(): void {
    let victim = -1
    let oldest = Infinity

    agents.forEach((card, index) => {
      if (card.status !== 'running' && (card.endedAt ?? 0) < oldest) {
        victim = index
        oldest = card.endedAt ?? 0
      }
    })
    agents.splice(Math.max(0, victim), 1)
  }

  function endAgent(card: AgentCard, reason: string, answer: string, at: number): void {
    const status = reason === 'answer' ? 'done' : reason === 'aborted' ? 'stopped' : 'failed'

    card.status = status
    card.endedAt = Math.max(at, card.startedAt)
    card.answer = brief(answer, ANSWER_CHARS)
    say(status === 'done' ? 'done' : 'error', whoIs(card.id), `${status} · ${took(card.endedAt - card.startedAt)}`, card.id, card.endedAt)
  }

  /** The main loop's turn ended: closes the receipt, or makes one from the event when no start was seen. */
  function endTurn({ durationMs, costUsd, nowMs }: Pick<TurnCompleted, 'durationMs' | 'costUsd' | 'nowMs'>): void {
    const turn = receipt
    const isOpen = turn !== null && turn.isRunning
    const length = known(durationMs)
    const startedAt = isOpen ? turn.startedAt : nowMs - Math.max(0, length ?? 0)

    receipt = {
      isRunning: false,
      startedAt,
      durationMs: length !== null && length >= 0 ? length : Math.max(0, nowMs - startedAt),
      agents: isOpen ? turn.agents : 0,
      edits: isOpen ? turn.edits : 0,
      errors: isOpen ? turn.errors : 0,
      costUsd: isOpen ? costOf(costAtStart, known(costUsd)) : null,
    }
  }

  return {
    /** A tool call begins: counts the tool; an MCP call goes in flight on its server. */
    toolStarted({ id, tool, agentId, nowMs }: ToolStarted): void {
      toolCounts.set(tool, (toolCounts.get(tool) ?? 0) + 1)

      const parts = mcpParts(tool)

      if (parts === null) {
        return
      }

      const server = serverOf(parts.server)

      server.calls += 1
      if (agentId !== undefined) {
        server.subagentCalls += 1
      }
      server.lastTool = parts.tool
      server.inFlight.push({ id, tool: parts.tool, startedAt: nowMs })
    },

    /**
     * A call's permission check: allowed by a rule, asked (pending until the
     * call settles) or denied (logged). A second check of one call replaces
     * the first.
     */
    toolChecked({ id, tool, input, decision, agentId, nowMs }: ToolChecked): void {
      const check: GateCheck = {
        id,
        tool,
        family: familyOf(tool),
        verdict: decision === 'allow' ? 'rule' : decision === 'deny' ? 'denied' : 'pending',
        inSubagent: agentId !== undefined,
        detail: describeInput(tool, input),
        at: nowMs,
      }
      const index = gate.findIndex(one => one.id === id)
      const before = index < 0 ? undefined : gate[index]

      if (before === undefined) {
        gate.push(check)
        if (gate.length > MAX_GATE) {
          gate.splice(0, gate.length - MAX_GATE)
        }
      } else {
        gate[index] = check
      }
      if (decision === 'deny' && before?.verdict !== 'denied') {
        say('denied', whoIs(agentId), subjectOf(tool, input), agentId, nowMs)
      }
    },

    /**
     * A call settled: settles its pending check (it ran -> asked, it was
     * refused -> denied), ends its MCP call in flight, feeds the running turn's
     * receipt, notes the call on its subagent's card and logs what is worth a
     * glance: edits, failures, refusals and git operations.
     */
    toolFinished({ id, tool, agentId, input, isError, isDenied, result, nowMs }: ToolFinished): void {
      const check = gate.find(one => one.id === id)
      // A call its check denied never ran, whatever the call reports; that denial is already in the log.
      const wasLogged = check?.verdict === 'denied'
      const isRefused = isDenied === true || wasLogged
      // A failed Agent call is its card's to report.
      const hasFailed = isError === true && !isRefused && tool !== 'Agent'
      const isEdit = EDIT_TOOLS.has(tool) && !hasFailed && !isRefused

      if (check?.verdict === 'pending') {
        check.verdict = isRefused ? 'denied' : 'asked'
      }

      const parts = mcpParts(tool)
      const server = parts === null ? undefined : servers.get(parts.server)
      const call = server?.inFlight.find(one => one.id === id)

      if (server !== undefined && call !== undefined) {
        server.inFlight = server.inFlight.filter(one => one.id !== id)
        // A refused call never reached the server: no time, no error.
        if (!isRefused) {
          // The tool's own time when the engine reported it, else the wall clock (a permission prompt included).
          const own = durations.get(id)
          const ms = own ?? Math.max(0, nowMs - call.startedAt)

          durations.delete(id)
          if (own === undefined) {
            settled.set(id, { server: server.server, ms })
            if (settled.size > MAX_SETTLED) {
              // The oldest is not waiting for its duration any more: its time stands.
              const [oldest, forgotten] = settled.entries().next().value as [string, { server: string; ms: number }]

              settled.delete(oldest)
              keepLongest(forgotten.server, forgotten.ms)
            }
          } else {
            keepLongest(server.server, ms)
          }
          latest.set(server.server, id)
          server.lastMs = ms
          server.totalMs += ms
          server.timedCalls = (server.timedCalls ?? 0) + 1
          server.maxMs = Math.max(server.maxMs, ms)
          server.lastAt = nowMs
          if (hasFailed) {
            server.errors += 1
          }
        }
      }

      const turn = receipt

      // Edits count from every loop; a failure counts only on the main loop, where the person sees it.
      if (turn !== null && turn.isRunning) {
        if (isEdit) {
          turn.edits += 1
        }
        if (hasFailed && agentId === undefined) {
          turn.errors += 1
        }
      }

      const card = cardOf(agentId)

      if (card !== undefined) {
        card.tools.push({ tool, text: cut(describeInput(tool, input), CARD_TOOL_CHARS), isError: hasFailed || isRefused })
        if (card.tools.length > CARD_TOOLS) {
          card.tools.splice(0, card.tools.length - CARD_TOOLS)
        }
      }
      if (isRefused) {
        if (!wasLogged) {
          say('denied', whoIs(agentId), subjectOf(tool, input), agentId, nowMs)
        }
      } else if (hasFailed) {
        say('error', whoIs(agentId), `${subjectOf(tool, input)} failed`, agentId, nowMs)
      } else {
        if (isEdit) {
          say('edit', whoIs(agentId), subjectOf(tool, input), agentId, nowMs)
        }
        if (tool === 'Bash' || tool === 'PowerShell') {
          for (const note of gitNotes(result)) {
            say('git', whoIs(agentId), note, agentId, nowMs)
          }
        }
      }
    },

    /** A subagent started: a running card (24 at most: the card that finished longest ago goes first). */
    agentSpawned({ id, type, description, model, nowMs }: AgentSpawned): void {
      const again = agents.findIndex(card => card.id === id)

      if (again >= 0) {
        agents.splice(again, 1)
      }

      const card: AgentCard = {
        id,
        type,
        description: brief(description, DETAIL_CHARS),
        model,
        status: 'running',
        startedAt: nowMs,
        endedAt: null,
        steps: 0,
        contextTokens: 0,
        outputTokens: 0,
        tools: [],
        answer: '',
      }

      agents.push(card)
      while (agents.length > MAX_AGENTS) {
        evictAgent()
      }
      if (receipt !== null && receipt.isRunning) {
        receipt.agents += 1
      }
      say('spawn', whoIs(id), `spawned · ${type}`, id, nowMs)

      const ended = early.get(id)

      if (ended !== undefined) {
        early.delete(id)
        endAgent(card, ended.reason, ended.answer, ended.at)
      }
    },

    /**
     * One model request of a subagent finished: a step more, its context is
     * the whole input of that request, its output adds up. A step after the
     * card ended means the agent runs again, so the card runs again.
     */
    agentStepped({ agentId, usage, stopReason, nowMs }: AgentStepped): void {
      const card = cardOf(agentId)

      if (card === undefined) {
        return
      }
      if (card.status !== 'running') {
        card.status = 'running'
        card.endedAt = null
        card.answer = ''
      }

      const context = count(usage?.input_tokens) + count(usage?.cache_read_input_tokens) + count(usage?.cache_creation_input_tokens)

      card.steps += 1
      // A request that failed reports nothing: the context it had stands.
      if (context > 0) {
        card.contextTokens = context
      }
      card.outputTokens += count(usage?.output_tokens)
      if (stopReason === 'max_tokens') {
        say('error', whoIs(agentId), 'hit max_tokens', agentId, nowMs)
      }
    },

    /** A main-loop turn begins: a running receipt, and the prompt's first line in the log. */
    turnStarted({ text: prompt, nowMs, costUsd }: TurnStarted): void {
      receipt = { isRunning: true, startedAt: nowMs, durationMs: null, agents: 0, edits: 0, errors: 0, costUsd: null }
      costAtStart = known(costUsd)

      const said = promptOf(prompt)

      if (said !== null) {
        say('prompt', said.who, said.line, undefined, nowMs)
      }
    },

    /**
     * A turn ended. The main loop's closes the receipt; a subagent's closes its
     * card (done for an answer, stopped for an interrupt, failed otherwise).
     */
    turnCompleted(end: TurnCompleted): void {
      if (end.agentId === undefined) {
        endTurn(end)

        return
      }

      const card = cardOf(end.agentId)

      if (card === undefined) {
        // It may have ended before its spawn was noted: keep the end for the card.
        early.set(end.agentId, { reason: end.reason, answer: end.answer, at: end.nowMs })
        if (early.size > MAX_AGENTS) {
          early.delete(early.keys().next().value ?? '')
        }
      } else if (card.status === 'running') {
        endAgent(card, end.reason, end.answer, end.nowMs)
      }
    },

    /** A compaction of the main conversation happened. */
    compacted({ trigger, nowMs }: Compacted): void {
      if (trigger === 'precompute') {
        return
      }
      compactions += 1
      say('compact', 'main', `context compacted (${trigger})`, undefined, nowMs)
    },

    /**
     * An MCP call's own duration, as classic PostToolUse reports it (the
     * permission prompt and hooks left out). Before the call settles it is
     * used then; after, it replaces the wall time the call was counted with.
     */
    mcpTimed({ id, ms }: { id: string; ms: number }): void {
      if (!Number.isFinite(ms) || ms < 0) {
        return
      }

      const early = settled.get(id)

      if (early === undefined) {
        durations.set(id, ms)
        if (durations.size > MAX_SETTLED) {
          durations.delete(durations.keys().next().value as string)
        }

        return
      }
      settled.delete(id)

      const server = servers.get(early.server)

      if (server !== undefined) {
        keepLongest(early.server, ms)
        server.totalMs = Math.max(0, server.totalMs - early.ms + ms)
        if (latest.get(early.server) === id) {
          server.lastMs = ms
        }
        // The longest of the calls whose time stands and of those still counted on wall time.
        server.maxMs = Math.max(
          longest.get(early.server) ?? 0,
          ...[...settled.values()].filter(one => one.server === early.server).map(one => one.ms),
        )
      }
    },

    /** Whether a clock is running in the view: an agent, an MCP call in flight, or the main loop's turn. */
    isBusy(): boolean {
      return (
        receipt?.isRunning === true ||
        agents.some(card => card.status === 'running') ||
        [...servers.values()].some(server => server.inFlight.length > 0)
      )
    },

    /** The session was cleared or resumed: forget everything. */
    reset(): void {
      durations.clear()
      settled.clear()
      longest.clear()
      latest.clear()
      toolCounts.clear()
      servers.clear()
      agents.length = 0
      early.clear()
      gate.length = 0
      log.length = 0
      receipt = null
      costAtStart = null
      compactions = 0
    },

    /**
     * A snapshot to draw at `nowMs`. MCP servers by calls, agents running
     * first then newest, the gate and the log newest last, tools by count. A
     * running turn's `durationMs` is the time so far. The snapshot shares
     * nothing with the tracker.
     */
    view(nowMs: number): SessionView {
      const ranked = agents
        .map((card, index) => ({ card, index }))
        .sort(
          (a, b) =>
            Number(b.card.status === 'running') - Number(a.card.status === 'running') ||
            b.card.startedAt - a.card.startedAt ||
            b.index - a.index,
        )

      return {
        mcp: [...servers.values()]
          .map(server => ({ ...server, inFlight: server.inFlight.map(call => ({ ...call })) }))
          .sort((a, b) => b.calls - a.calls || compare(a.server, b.server)),
        agents: ranked.map(({ card }) => ({ ...card, tools: card.tools.map(one => ({ ...one })) })),
        gate: gate.map(check => ({ ...check })),
        log: log.map(entry => ({ ...entry })),
        receipt:
          receipt === null
            ? null
            : { ...receipt, durationMs: receipt.isRunning ? Math.max(0, nowMs - receipt.startedAt) : receipt.durationMs },
        compactions,
        tools: [...toolCounts]
          .map(([name, total]) => ({ name, count: total }))
          .sort((a, b) => b.count - a.count || compare(a.name, b.name)),
      }
    },
  }
}

/** What `createSessionLog` returns. */
export type SessionLog = ReturnType<typeof createSessionLog>
