// Pure helpers for the status line: number and time formats, gauges, the
// model's label, git output parsing, and the two rows as styled spans. Nothing
// here calls the engine, so the hooks module and the tests share it.

import type { SessionRateLimit, SessionUsage } from 'claude-code'

import type { CiRun } from './model'

/** Where the session is: the first row's directory label and its git figures. */
export type StatusWhere = {
  /** The repository's name plus the current directory inside it, or the directory's name outside one. */
  label: string
  /** The linked worktree's directory name; null in a repository's main working tree. */
  worktree: string | null
  /** null outside a git repository. */
  git: StatusGit | null
}

export type StatusGit = {
  /** The branch, or `HEAD <short sha>` when detached. */
  branch: string
  ahead: number
  behind: number
  /** Lines added and removed against the branch's base, uncommitted changes included. */
  added: number
  removed: number
  /** Tracked files with staged or unstaged changes. */
  changed: number
}

export type StatusPr = {
  number: number
  review: 'approved' | 'changes_requested' | 'pending' | 'draft' | null
}

export type StatusUsage = {
  /** The model's label, as `Opus 5.5 1M`. */
  model: string
  /** Input tokens of the last response; null before the first one, and right after a compaction. */
  tokens: number | null
  /** The compaction window the context bar measures against. */
  budget: number
  cost: number | null
  fiveHour: number | null
  sevenDay: number | null
  /** Seconds until the 7-day window resets; null when it is not reported. */
  sevenDayResetSec: number | null
}

export type StatusSession = {
  effort: string | null
  agent: string | null
  /** Main-loop token sums for the cache hit ratio. */
  cacheRead: number
  cacheWrite: number
  uncached: number
}

/** The 7-day token totals of the top model families, largest first. */
export type StatusWeekly = { family: string; tokens: number }[]

/** The branch's latest CI run as the status line draws it; a `CiRun` fits. */
export type StatusCi = Pick<CiRun, 'outcome' | 'isRunning' | 'workflow' | 'at'>

/** The compact button: idle waits for a press, armed for the press that confirms it, running is compacting. */
export type CompactState = 'idle' | 'armed' | 'running'

/** What a span means; the hooks module maps each tone to a theme color. */
export type Tone = 'ok' | 'warn' | 'bad' | 'muted' | 'path' | 'branch' | 'link'
export type Span = {
  text: string
  tone?: Tone
  isBold?: boolean
  /** The action a press on the span asks for; the hooks module draws a span that carries one as a button. */
  press?: 'compact'
}
/** Spans drawn side by side; a row's segments are joined by a separator. */
export type Segment = Span[]
export type Row = Segment[]

export type GitStatus = {
  branch: string
  isUnborn: boolean
  ahead: number
  behind: number
  changed: number
}

export type RowsInput = {
  where: StatusWhere | null
  pr: StatusPr | null
  usage: StatusUsage | null
  session: StatusSession
  weekly: StatusWeekly | null
  hasNerdFont: boolean
  /** The branch's latest CI run; null, or left out, draws no CI segment. */
  ci?: StatusCi | null
  /** The compact button's state; `idle` when left out. */
  compact?: CompactState
  /** The time now, epoch ms. The CI segment's age and elapsed time need it and are left out without it. */
  nowMs?: number
}

const UNITS: readonly (readonly [number, string])[] = [
  [1e3, 'k'],
  [1e6, 'M'],
  [1e9, 'B'],
  [1e12, 'T'],
]
const FAMILIES = ['opus', 'fable', 'sonnet', 'haiku'] as const
/** Cells of the context gauge. */
const BAR_CELLS = 10
/** Cells of each plan limit's gauge. */
const LIMIT_CELLS = 5
const GAUGE_ON = '▰'
const GAUGE_OFF = '▱'
/** The effort levels, lowest first: a level fills as many cells as its place in this list. */
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
const REVIEW_MARKS: Record<NonNullable<StatusPr['review']>, readonly [string, Tone]> = {
  approved: ['✓', 'ok'],
  changes_requested: ['✗', 'bad'],
  pending: ['○', 'warn'],
  draft: ['◌', 'muted'],
}

/** 950 -> "950", 1250 -> "1.3k", 10500 -> "11k", 999500 -> "1.0M": never "10.0k" or "1000k". */
export function human(n: number): string {
  const value = Number.isFinite(n) && n > 0 ? n : 0

  if (value < 999.5) {
    return String(Math.round(value))
  }
  for (const [limit, suffix] of UNITS) {
    const scaled = value / limit

    if (scaled < 9.95) {
      return `${scaled.toFixed(1)}${suffix}`
    }
    if (scaled < 999.5) {
      return `${Math.round(scaled)}${suffix}`
    }
  }

  return `${Math.round(value / 1e12)}T`
}

/** To the nearest minute: 3600 -> "1h00m", 90000 -> "1d1h", anything past -> "0m". */
export function duration(seconds: number): string {
  const minutes = Math.max(0, Math.round((Number.isFinite(seconds) ? seconds : 0) / 60))
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const rest = minutes % 60

  if (days > 0) {
    return `${days}d${hours}h`
  }
  if (hours > 0) {
    return `${hours}h${String(rest).padStart(2, '0')}m`
  }

  return `${rest}m`
}

/**
 * A span of milliseconds as a CI run shows it, cut down to its largest unit:
 * "45s", "3m", "5h", "2d". `isPrecise` keeps the next unit while a run is
 * still going: "1m20s", "1h05m". A span below zero or not a number is "0s".
 */
export function elapsed(ms: number, isPrecise: boolean): string {
  const seconds = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000))
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)

  if (seconds < 60) {
    return `${seconds}s`
  }
  if (minutes < 60) {
    return isPrecise ? `${minutes}m${String(seconds % 60).padStart(2, '0')}s` : `${minutes}m`
  }
  if (hours < 24) {
    return isPrecise ? `${hours}h${String(minutes % 60).padStart(2, '0')}m` : `${hours}h`
  }

  return `${Math.floor(hours / 24)}d`
}

/**
 * A gauge as Claude Code draws one, the used cells first: `gauge(32, 10)` is
 * "▰▰▰▱▱▱▱▱▱▱". The nearest cell is filled, but any use above zero fills at
 * least one and 100 fills all; more than 100 fills all too, and a percentage
 * at or below zero, or not a number, fills none. A width below one is an empty
 * string.
 */
export function gauge(pct: number, width: number): string {
  const cells = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0
  const used = Math.min(pct, 100)
  // NaN is not above zero either, so it fills none.
  const filled = used > 0 ? Math.min(cells, Math.max(1, Math.round((used * cells) / 100))) : 0

  return `${GAUGE_ON.repeat(filled)}${GAUGE_OFF.repeat(cells - filled)}`
}

/** The effort level as a five-cell gauge, "high" -> "▮▮▮▯▯"; null for a level this does not know. */
export function effortGauge(level: string): string | null {
  const rank = EFFORT_LEVELS.findIndex(known => known === level) + 1

  return rank > 0 ? `${'▮'.repeat(rank)}${'▯'.repeat(EFFORT_LEVELS.length - rank)}` : null
}

function capitalize(word: string): string {
  return `${word.charAt(0).toUpperCase()}${word.slice(1)}`
}

/** "claude-opus-5-5[1m]" -> "Opus 5.5 1M"; an id that names no Claude model is shown as given. */
export function modelLabel(id: string, window: number): string {
  const isLong = /\[1m\]/i.test(id) || window >= 1_000_000
  const bare = id.replace(/\[1m\]/gi, '').trim()
  const at = bare.toLowerCase().lastIndexOf('claude-')

  if (at < 0) {
    return bare === '' ? '?' : bare
  }

  const name = bare
    .slice(at + 'claude-'.length)
    .replace(/[@:].*$/, '')
    .replace(/-v\d+$/, '')
    .replace(/-\d{8}$/, '')
  const parts = name.split('-').filter(part => part !== '')
  const family = parts.find(part => !/^\d+$/.test(part))

  if (family === undefined) {
    return bare
  }

  const version = parts.filter(part => /^\d+$/.test(part)).join('.')
  const label = version === '' ? capitalize(family) : `${capitalize(family)} ${version}`

  return isLong ? `${label} 1M` : label
}

/** A model id's family for the weekly totals: Opus, Fable, Sonnet, Haiku, or its first word. */
export function familyLabel(model: string): string {
  const lower = model.toLowerCase()
  const family = FAMILIES.find(name => lower.includes(name))

  if (family !== undefined) {
    return capitalize(family)
  }

  const base = (model.split('/').pop() ?? model).split('-')[0] ?? model

  return capitalize(base.slice(0, 8))
}

/** The top three families of a `by_model` map, summed per family, largest first. */
export function familyTotals(byModel: Readonly<Record<string, unknown>>): StatusWeekly {
  const totals = new Map<string, number>()

  for (const [model, tokens] of Object.entries(byModel)) {
    if (typeof tokens === 'number' && tokens > 0) {
      const family = familyLabel(model)

      totals.set(family, (totals.get(family) ?? 0) + tokens)
    }
  }

  return [...totals]
    .map(([family, tokens]) => ({ family, tokens }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 3)
}

/** What statusline-weekly.py printed, as the weekly segment; null when there is nothing to show. */
export function weeklyOf(stdout: string): StatusWeekly | null {
  try {
    const data: unknown = JSON.parse(stdout)
    const byModel = typeof data === 'object' && data !== null ? (data as { by_model?: unknown }).by_model : undefined

    if (typeof byModel !== 'object' || byModel === null) {
      return null
    }

    const top = familyTotals(byModel as Record<string, unknown>)

    return top.length > 0 ? top : null
  } catch {
    return null
  }
}

/** Reads `git status --porcelain=v2 --branch` output. */
export function parseStatus(stdout: string): GitStatus {
  let oid = ''
  let head = ''
  let ahead = 0
  let behind = 0
  let changed = 0

  for (const line of stdout.split('\n')) {
    if (line.startsWith('# branch.oid ')) {
      oid = line.slice('# branch.oid '.length).trim()
    } else if (line.startsWith('# branch.head ')) {
      head = line.slice('# branch.head '.length).trim()
    } else if (line.startsWith('# branch.ab ')) {
      const counts = /^\+(\d+) -(\d+)$/.exec(line.slice('# branch.ab '.length).trim())

      if (counts !== null) {
        ahead = Number(counts[1])
        behind = Number(counts[2])
      }
    } else if (/^[12u] /.test(line)) {
      changed += 1
    }
  }

  const branch = head === '(detached)' ? `HEAD ${oid.slice(0, 7)}` : head === '' ? '?' : head

  return { branch, isUnborn: oid === '(initial)', ahead, behind, changed }
}

/** Sums `git diff --numstat` output; binary files (`-`) count nothing. */
export function parseNumstat(stdout: string): { added: number; removed: number } {
  let added = 0
  let removed = 0

  for (const line of stdout.split('\n')) {
    const [plus, minus] = line.split('\t')

    if (plus !== undefined && minus !== undefined && /^\d+$/.test(plus) && /^\d+$/.test(minus)) {
      added += Number(plus)
      removed += Number(minus)
    }
  }

  return { added, removed }
}

export function baseName(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/').filter(part => part !== '')

  return parts[parts.length - 1] ?? path
}

/**
 * The first row's label and worktree, from `git rev-parse --show-toplevel
 * --show-prefix --git-dir`. A linked worktree's git dir is
 * `<main>/.git/worktrees/<id>`: the label then names the main repository.
 */
export function placeOf(top: string, prefix: string, gitDir: string): Pick<StatusWhere, 'label' | 'worktree'> {
  const linked = /^(.*)\/worktrees\/[^/]+$/.exec(gitDir.replace(/\\/g, '/').replace(/\/+$/, ''))
  const main = linked?.[1]
  const name =
    main === undefined ? baseName(top) : baseName(main.endsWith('/.git') ? main.slice(0, -'/.git'.length) : main.replace(/\.git$/, ''))
  const sub = prefix.replace(/\\/g, '/').replace(/\/+$/, '')

  return { label: sub === '' ? name : `${name}/${sub}`, worktree: main === undefined ? null : baseName(top) }
}

/** `gh pr view --json number,state,isDraft,reviewDecision` output, for an open PR only. */
export function prOf(stdout: string): StatusPr | null {
  try {
    const data = JSON.parse(stdout) as { number?: unknown; state?: unknown; isDraft?: unknown; reviewDecision?: unknown }

    if (typeof data.number !== 'number' || data.state !== 'OPEN') {
      return null
    }

    const review =
      data.isDraft === true
        ? 'draft'
        : data.reviewDecision === 'APPROVED'
          ? 'approved'
          : data.reviewDecision === 'CHANGES_REQUESTED'
            ? 'changes_requested'
            : data.reviewDecision === 'REVIEW_REQUIRED'
              ? 'pending'
              : null

    return { number: data.number, review }
  } catch {
    return null
  }
}

/** One plan window's percentage, and the seconds left until it resets; null once it has reset. */
export function limitOf(
  limits: readonly SessionRateLimit[],
  kind: string,
  nowMs: number,
): { percent: number; resetSec: number | null } | null {
  const limit = limits.find(one => one.kind === kind)

  if (limit === undefined || !Number.isFinite(limit.percentUsed)) {
    return null
  }

  const resetsAt = limit.resetsAt === undefined ? Number.NaN : Date.parse(limit.resetsAt)

  if (Number.isFinite(resetsAt) && resetsAt <= nowMs) {
    return null
  }

  return { percent: limit.percentUsed, resetSec: Number.isFinite(resetsAt) ? (resetsAt - nowMs) / 1000 : null }
}

/** The second row's figures, from `$.session.usage()` and the compaction window. */
export function usageOf(figures: SessionUsage, modelId: string, budget: number | null, nowMs: number): StatusUsage {
  const window = figures.context.window > 0 ? figures.context.window : 200_000
  const fiveHour = limitOf(figures.rateLimits, 'five_hour', nowMs)
  const sevenDay = limitOf(figures.rateLimits, 'seven_day', nowMs)

  return {
    model: modelLabel(modelId, window),
    tokens: figures.context.tokens ?? null,
    budget: budget !== null && budget > 0 && budget < window ? budget : window,
    cost: figures.cost?.usd ?? null,
    fiveHour: fiveHour?.percent ?? null,
    sevenDay: sevenDay?.percent ?? null,
    sevenDayResetSec: sevenDay?.resetSec ?? null,
  }
}

/** Cache reads over every input token of the main loop's requests, as a whole percentage. */
export function cacheRatio(session: StatusSession): number | null {
  const total = session.cacheRead + session.cacheWrite + session.uncached

  return total > 0 ? Math.round((session.cacheRead / total) * 100) : null
}

/** The tone of a percentage, judged on the figure as drawn. */
function percentTone(shown: number, warnAt: number, badAt: number): Tone {
  return shown < warnAt ? 'ok' : shown < badAt ? 'warn' : 'bad'
}

function gitSegment(git: StatusGit, hasNerdFont: boolean): Segment {
  const spans: Segment = [{ text: `${hasNerdFont ? ' ' : ''}${git.branch}`, tone: 'branch', isBold: true }]

  if (git.ahead > 0 || git.behind > 0) {
    spans.push({ text: ' ' })
    if (git.ahead > 0) {
      spans.push({ text: `↑${git.ahead}`, tone: 'ok' })
    }
    if (git.behind > 0) {
      spans.push({ text: `↓${git.behind}`, tone: 'bad' })
    }
  }
  if (git.added > 0 || git.removed > 0) {
    spans.push({ text: ' ' }, { text: `+${git.added}`, tone: 'ok' }, { text: '/' }, { text: `-${git.removed}`, tone: 'bad' })
  }
  if (git.changed > 0) {
    spans.push({ text: ' ' }, { text: `✱${git.changed}`, tone: 'warn' })
  }

  return spans
}

function prSegment(pr: StatusPr): Segment {
  const spans: Segment = [{ text: `PR #${pr.number}`, tone: 'link' }]

  if (pr.review !== null) {
    const [mark, tone] = REVIEW_MARKS[pr.review]

    spans.push({ text: ' ' }, { text: mark, tone })
  }

  return spans
}

/** A gauge as two spans: the used cells in the tone, the rest muted. */
function gaugeSpans(shown: number, width: number, tone: Tone): Span[] {
  const cells = gauge(shown, width)
  const used = cells.lastIndexOf(GAUGE_ON) + 1
  const spans: Span[] = []

  if (used > 0) {
    spans.push({ text: cells.slice(0, used), tone })
  }
  if (used < cells.length) {
    spans.push({ text: cells.slice(used), tone: 'muted' })
  }

  return spans
}

/**
 * The compact button as a span: "⟲ compact" waits for a press, "⟲ confirm"
 * for the press that confirms it, and "⟲ compacting…" has none left to take.
 * Only the first two carry `press`.
 */
export function compactSpan(state: CompactState): Span {
  if (state === 'running') {
    return { text: '⟲ compacting…', tone: 'muted' }
  }
  if (state === 'armed') {
    return { text: '⟲ confirm', tone: 'warn', press: 'compact' }
  }

  return { text: '⟲ compact', tone: 'muted', press: 'compact' }
}

/**
 * The context segment: `ctx ▰▰▰▱▱▱▱▱▱▱ 32% 95k/300k`, measured against the
 * compaction window, a `compact` warning from 85% on, and the compact button
 * last. The gauge and the tone follow the percentage as drawn; no tokens yet
 * count as none, and a budget of zero as 0%.
 */
export function contextSegment(usage: StatusUsage, compact: CompactState = 'idle'): Segment {
  const used = usage.tokens !== null && Number.isFinite(usage.tokens) ? Math.max(0, usage.tokens) : 0
  const shown = usage.budget > 0 ? Math.round((Math.min(used, usage.budget) * 100) / usage.budget) : 0
  const tone = percentTone(shown, 50, 85)
  const spans: Segment = [
    { text: 'ctx ', tone: 'muted' },
    ...gaugeSpans(shown, BAR_CELLS, tone),
    { text: ` ${shown}%`, tone },
    { text: ` ${human(used)}/${human(usage.budget)}`, tone: 'muted' },
  ]

  if (shown >= 85) {
    spans.push({ text: ' compact', tone: 'bad' })
  }
  spans.push({ text: ' ' }, compactSpan(compact))

  return spans
}

/**
 * The plan limits: `5h ▰▱▱▱▱ 2% · 7d ▰▰▱▱▱ 49% ↻3d4h`, a window the plan does
 * not report left out, the 7-day window's reset time after its percentage.
 * Empty when neither is reported.
 */
export function limitsSegment(usage: StatusUsage): Segment {
  const spans: Segment = []

  for (const [tag, percent] of [
    ['5h', usage.fiveHour],
    ['7d', usage.sevenDay],
  ] as const) {
    if (percent === null) {
      continue
    }

    const shown = Math.round(percent)
    const tone = percentTone(shown, 50, 80)

    if (spans.length > 0) {
      spans.push({ text: ' · ', tone: 'muted' })
    }
    spans.push({ text: `${tag} `, tone: 'muted' }, ...gaugeSpans(shown, LIMIT_CELLS, tone), { text: ` ${shown}%`, tone })
    if (tag === '7d' && usage.sevenDayResetSec !== null) {
      spans.push({ text: ` ↻${duration(usage.sevenDayResetSec)}`, tone: 'muted' })
    }
  }

  return spans
}

/** The model's name, then the effort as a gauge and its word: `Opus 5.5 1M ▮▮▮▯▯ high`; a level that is not known is the word alone. */
function headSegment(model: string, effort: string | null): Segment {
  const level = effort?.trim() ?? ''
  const spans: Segment = [{ text: model, isBold: true }]

  if (level !== '') {
    const cells = effortGauge(level)

    spans.push({ text: cells === null ? ` ${level}` : ` ${cells} ${level}`, tone: 'muted' })
  }

  return spans
}

/** How much of a failing check's name the status line keeps. */
const CI_NAME_CHARS = 40

/**
 * The branch's CI as a segment: `CI ✓ 3m` (passed, how long ago), `CI ● 1m20s`
 * (running, how long it has run), `CI ✗ build` (failed, which check) and
 * `CI ⊘ 3m` (skipped or cancelled). A time GitHub did not report draws the
 * mark alone. Null without `nowMs`, except for a failure, which needs no time.
 */
export function ciSegment(ci: StatusCi, nowMs: number | undefined): Segment | null {
  const label: Span = { text: 'CI ', tone: 'muted' }
  const isLive = ci.isRunning || ci.outcome === 'pending'

  if (ci.outcome === 'failed' && !isLive) {
    // One short line: a check's name is text from outside.
    const name = ci.workflow
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, CI_NAME_CHARS)

    return [label, { text: name === '' ? '✗' : `✗ ${name}`, tone: 'bad' }]
  }
  if (nowMs === undefined || !Number.isFinite(nowMs)) {
    return null
  }

  // A time GitHub did not give (0) draws the mark alone, never a clock counted from 1970.
  const isTimed = Number.isFinite(ci.at) && ci.at > 0

  if (isLive) {
    return [label, { text: isTimed ? `● ${elapsed(nowMs - ci.at, true)}` : '● running', tone: 'warn' }]
  }

  const age = isTimed ? ` ${elapsed(nowMs - ci.at, false)}` : ''

  return ci.outcome === 'passed'
    ? [label, { text: '✓', tone: 'ok' }, ...(age === '' ? [] : [{ text: age, tone: 'muted' as const }])]
    : [label, { text: `⊘${age}`, tone: 'muted' }]
}

function placeRow({ where, pr, ci = null, nowMs, session, hasNerdFont }: RowsInput): Row {
  const row: Row = []

  if (where !== null) {
    row.push([{ text: where.label, tone: 'path', isBold: true }])
    if (where.worktree !== null) {
      row.push([{ text: `⎇ ${where.worktree}`, tone: 'link' }])
    }
    if (where.git !== null) {
      row.push(gitSegment(where.git, hasNerdFont))
    }
  }
  if (pr !== null) {
    row.push(prSegment(pr))
  }

  const ciSpans = ci === null ? null : ciSegment(ci, nowMs)

  if (ciSpans !== null) {
    row.push(ciSpans)
  }
  if (session.agent !== null) {
    row.push([{ text: `@${session.agent}`, tone: 'muted' }])
  }

  return row
}

function costRow({ usage, session, weekly, compact = 'idle' }: RowsInput): Row {
  const row: Row = []

  if (usage !== null) {
    row.push(headSegment(usage.model, session.effort), contextSegment(usage, compact))
  }

  const hit = cacheRatio(session)

  if (hit !== null) {
    row.push([{ text: 'cache ', tone: 'muted' }, { text: `${hit}%`, tone: hit >= 70 ? 'ok' : 'warn' }])
  }
  if (usage !== null && usage.cost !== null) {
    const shown = usage.cost.toFixed(2)

    row.push([{ text: `$${shown}`, tone: Number(shown) < 5 ? 'ok' : 'warn' }])
  }

  const limits = usage === null ? [] : limitsSegment(usage)

  if (limits.length > 0) {
    row.push(limits)
  }
  if (weekly !== null && weekly.length > 0) {
    row.push([{ text: `7d ${weekly.map(one => `${one.family} ${human(one.tokens)}`).join(' ')}`, tone: 'muted' }])
  }

  return row
}

/**
 * The status line's rows, each a list of segments; empty rows are left out.
 * The first is the place (directory, git, pull request, CI, agent), the second
 * the model, context, cache, cost and limits.
 */
export function rowsOf(input: RowsInput): Row[] {
  return [placeRow(input), costRow(input)].filter(row => row.length > 0)
}

/** A row as plain text, segments joined the way they are drawn. */
export function rowText(row: Row): string {
  return row.map(segment => segment.map(span => span.text).join('')).join(' │ ')
}

/** Whether two plain-data values are the same, so a lane writes only what changed. */
export function isSame(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
