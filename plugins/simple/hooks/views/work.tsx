// The Work tab: what the team ships on GitHub, drawn from what the github lane
// last read. The sections run as the questions come: which ticket is this
// branch on, where is its pull request and did CI pass, who is on what, what
// waits on me. Every row is cut to the pane's width. Plain data in, elements
// out; the engine is not touched.

import type { Color, RenderElement } from 'claude-code'

import type { Check, CheckOutcome, CiRun, IssueRef, PullRequest, Work } from '../model'
import {
  ago,
  CHECK_MARKS,
  clean,
  clock,
  dotted,
  gauge,
  layout,
  MERGE_WORDS,
  MUTED,
  names,
  reviewOf,
  REVIEW_MARKS,
  worstOutcome,
  type Kit,
  type Layout,
  type Mark,
  type Part,
} from './kit'

/** What the Work tab needs besides its data: the time, the room, and what its two buttons do. */
export type WorkOptions = {
  /** Now, as epoch ms: every age and running clock counts from it. */
  nowMs: number
  /** Cells across the pane's body. */
  width: number
  /** Asks the github lane to read GitHub again. */
  onRefresh: () => void
  /** Puts a URL on the clipboard. */
  onCopy: (url: string) => void
}

type ReviewerState = PullRequest['reviews'][number]['state']

const MAX_TICKETS = 3
/** Failing and pending checks named under the counts, each. */
const MAX_NAMES = 5
const MAX_BOARD = 8
const MAX_UNSTARTED = 5
const MAX_QUEUE = 5
const GAUGE_CELLS = 5
const INDENT: Part = { text: '  ' }
const SOURCES: Record<IssueRef['source'], string> = { branch: 'branch', commit: 'commit', pr: 'PR' }
/** What one reviewer's latest review shows as. */
const REVIEWER_MARKS: Record<ReviewerState, { mark: string; color: Color }> = {
  approved: { mark: '✓', color: 'success' },
  changes_requested: { mark: '✗', color: 'error' },
  commented: { mark: '○', color: MUTED },
  dismissed: { mark: '–', color: MUTED },
  pending: { mark: '○', color: 'warning' },
}
/** The board's mark for a pull request nobody asked a review on. */
const NO_REVIEW: Mark = { mark: '·', words: 'no review', color: MUTED }

/** The repository and branch, and at the right a button to read GitHub again that says how old the data is. */
function titleRow(ui: Layout, work: Work, opts: WorkOptions): RenderElement {
  const repo = clean(work.repo ?? '')
  const branch = clean(work.branch ?? '')
  const parts: Part[] =
    repo === '' && branch === ''
      ? [{ text: 'no repository', color: MUTED }]
      : [
          { text: repo, bold: true, color: 'blue' },
          { text: repo !== '' && branch !== '' ? ' · ' : '', color: MUTED },
          { text: branch, color: 'magenta', min: 8 },
        ]

  return ui.withButton(parts, {
    key: 'refresh',
    label: work.fetchedAt > 0 ? `↻ ${ago(opts.nowMs, work.fetchedAt)}` : '↻',
    dim: true,
    onPress: opts.onRefresh,
  })
}

/** Why GitHub is not shown, in the warning color and in full, and the refresh hint when a press can clear it. */
function problemRows(ui: Layout, problem: string, canRetry: boolean): RenderElement[] {
  const rows = [ui.wrapped(problem, { color: 'warning', chars: ui.room * 3 })]

  if (canRetry) {
    rows.push(ui.empty('press ↻ to read GitHub again'))
  }

  return rows
}

function ticketMeta(ticket: IssueRef): Part[] {
  return dotted([
    { text: clean(ticket.state), color: MUTED },
    { text: names(ticket.labels, 3), color: MUTED, drop: 2 },
    { text: names(ticket.assignees, 2), color: MUTED, drop: 1 },
    { text: `from ${SOURCES[ticket.source]}`, color: MUTED },
  ])
}

function ticketRows(ui: Layout, tickets: readonly IssueRef[]): RenderElement[] {
  const rows = [ui.header('Ticket', tickets.length > 1 ? String(tickets.length) : '')]

  if (tickets.length === 0) {
    rows.push(
      ui.line([
        { text: 'no ticket linked', color: 'warning' },
        { text: ': add "Closes #N" to the PR', color: 'warning', drop: 1 },
      ]),
    )
  }
  for (const ticket of tickets.slice(0, MAX_TICKETS)) {
    rows.push(
      ui.line([
        { text: `#${ticket.number}`, color: 'cyan' },
        { text: ticket.title === '' ? '' : ` ${clean(ticket.title)}`, min: 10 },
      ]),
      ui.line([INDENT, ...ticketMeta(ticket)]),
    )
  }
  if (tickets.length > MAX_TICKETS) {
    rows.push(ui.line([{ text: `+${tickets.length - MAX_TICKETS} more`, color: MUTED }]))
  }

  return rows
}

/** The decision, who is still asked, and what each reviewer last said. */
function reviewRows(ui: Layout, pr: PullRequest): RenderElement[] {
  const review = reviewOf(pr)
  const waiting = names(pr.reviewers, 3)
  const rows = [
    ui.line([
      review === null ? { text: 'no review required', color: MUTED } : { text: `${review.mark} ${review.words}`, color: review.color },
      { text: waiting === '' ? '' : ` · waiting on ${waiting}`, color: MUTED, min: 12 },
    ]),
  ]

  if (pr.reviews.length > 0) {
    rows.push(
      ui.line([
        { text: 'reviews ', color: MUTED },
        ...pr.reviews.slice(0, 4).map((one, index): Part => {
          const mark = REVIEWER_MARKS[one.state]

          return {
            text: `${index === 0 ? '' : '  '}${mark.mark} ${clean(one.author)}`,
            color: mark.color,
            ...(index === 0 ? {} : { drop: index }),
          }
        }),
      ]),
    )
  }

  return rows
}

function mergeRow(ui: Layout, pr: PullRequest): RenderElement | null {
  // A draft says so in its review row already.
  if (pr.merge === 'draft' && reviewOf(pr) === REVIEW_MARKS.draft) {
    return null
  }

  const merge = MERGE_WORDS[pr.merge]
  // Behind what it merges into, which is not always the default branch.
  const words = pr.merge === 'behind' ? `behind ${clean(pr.base ?? '') || 'its base'}` : merge.words
  const parts: Part[] = [
    { text: 'merge ', color: MUTED },
    { text: words, color: merge.color },
  ]

  if (pr.isAutoMerge) {
    parts.push({ text: ' · auto-merge on', color: 'success', drop: 1 })
  }

  return ui.line(parts)
}

/**
 * The counts of the checks, worst first so the one that opens the row is the last to give way, then the names
 * of the ones that failed and the ones still running; the passed are a count only.
 */
function checkRows(ui: Layout, checks: readonly Check[]): RenderElement[] {
  if (checks.length === 0) {
    return [
      ui.line([
        { text: 'checks ', color: MUTED },
        { text: 'none', color: MUTED },
      ]),
    ]
  }

  const by = (outcome: CheckOutcome): Check[] => checks.filter(check => check.outcome === outcome)
  const [passed, failed, pending, skipped] = [by('passed'), by('failed'), by('pending'), by('skipped')]
  const judged = checks.length - skipped.length
  const tally = (list: readonly Check[], outcome: CheckOutcome, drop: number): Part | null => {
    const mark = CHECK_MARKS[outcome]

    return list.length === 0 ? null : { text: `${mark.mark} ${list.length} ${mark.words}`, color: mark.color, drop }
  }
  const gaugeColor: Color = failed.length > 0 ? 'error' : pending.length > 0 ? 'warning' : 'success'
  const rows = [
    ui.line([
      { text: 'checks ', color: MUTED },
      { text: judged === 0 ? '' : `${gauge((100 * passed.length) / judged, GAUGE_CELLS)} `, color: gaugeColor, drop: 6 },
      ...dotted([tally(failed, 'failed', 1), tally(pending, 'pending', 2), tally(passed, 'passed', 3), tally(skipped, 'skipped', 4)]),
    ]),
  ]

  for (const [list, outcome] of [
    [failed, 'failed'],
    [pending, 'pending'],
  ] as const) {
    const mark = CHECK_MARKS[outcome]

    for (const check of list.slice(0, MAX_NAMES)) {
      rows.push(
        ui.line([
          { text: `  ${mark.mark} `, color: mark.color },
          { text: clean(check.name), min: 8 },
        ]),
      )
    }
    if (list.length > MAX_NAMES) {
      rows.push(ui.line([{ text: `  +${list.length - MAX_NAMES} more ${mark.words}`, color: MUTED }]))
    }
  }

  return rows
}

function prRows(ui: Layout, pr: PullRequest | null, opts: WorkOptions): RenderElement[] {
  const rows = [ui.header('Pull request')]

  if (pr === null) {
    return [...rows, ui.empty('no open PR for this branch')]
  }

  const title: Part[] = [
    { text: `#${pr.number}`, color: 'cyan', bold: true },
    { text: ` ${clean(pr.title)}`, min: 10 },
  ]
  const merge = mergeRow(ui, pr)

  rows.push(
    pr.url === '' ? ui.line(title) : ui.withButton(title, { key: 'copy-pr', label: '⧉', dim: true, onPress: () => opts.onCopy(pr.url) }),
    ...reviewRows(ui, pr),
    ...(merge === null ? [] : [merge]),
    ...checkRows(ui, pr.checks),
  )

  return rows
}

function ciRows(ui: Layout, ci: CiRun | null, nowMs: number): RenderElement[] {
  const rows = [ui.header('CI')]

  if (ci === null) {
    return [...rows, ui.empty('no CI run for this branch')]
  }

  const mark = ci.isRunning ? CHECK_MARKS.pending : CHECK_MARKS[ci.outcome]
  const age = ago(nowMs, ci.at)
  // A start or an end that is not known leaves the time out, not a clock of decades.
  const when = ci.isRunning ? (age === '' ? 'running' : `running ${clock(nowMs - ci.at)}`) : age === '' ? '' : `${age} ago`

  rows.push(
    ui.line([
      { text: `${mark.mark} `, color: mark.color },
      { text: clean(ci.workflow), bold: true, min: 8 },
      ...dotted(
        [
          { text: when, color: MUTED },
          { text: clean(ci.sha), color: MUTED, drop: 1 },
        ],
        true,
      ),
    ]),
  )

  return rows
}

/** "closes #12, #14 +1": the issues a pull request closes on merge; "" when it closes none. */
function closes(pr: PullRequest): string {
  const issues = names(
    pr.closes.map(issue => `#${issue}`),
    2,
  )

  return issues === '' ? '' : `closes ${issues}`
}

/** One open pull request: its review and checks marks, number and title, who wrote it and what it closes; bold when it is the person's own. */
function boardRow(ui: Layout, pr: PullRequest, isOwn: boolean): RenderElement {
  const review = reviewOf(pr) ?? NO_REVIEW
  // Board rows are read without their checks (too heavy for a whole repository): no mark, not "no checks".
  const worst = worstOutcome(pr.checks)
  const checks = worst === null ? null : CHECK_MARKS[worst]

  return ui.line([
    { text: `${review.mark} `, color: review.color },
    ...(checks === null ? [] : [{ text: `${checks.mark} `, color: checks.color }]),
    { text: `#${pr.number}`, color: 'cyan', bold: isOwn },
    { text: ` ${clean(pr.title)}`, bold: isOwn, min: 12 },
    ...dotted(
      [
        { text: clean(pr.author), color: MUTED, drop: 1 },
        { text: closes(pr), color: MUTED, drop: 2 },
      ],
      true,
    ),
  ])
}

function boardRows(ui: Layout, work: Work): RenderElement[] {
  const { board, unstarted, totals } = work

  if (board === null) {
    return [ui.header('Team board'), ui.empty('loading…')]
  }

  // The lists hold the newest few; GitHub's totals count them all, the branch's own PR among them,
  // which the board leaves out when the Pull request section shows it.
  const ownElsewhere = work.pr !== null && !board.some(pr => pr.number === work.pr?.number) ? 1 : 0
  const open = totals?.board ?? board.length + ownElsewhere
  const rows = [ui.header('Team board', open > 0 ? `${open} open` : '')]
  const shown = board.slice(0, MAX_BOARD)
  const boardRest = open - shown.length - ownElsewhere

  if (board.length === 0 && work.pr === null) {
    rows.push(ui.empty('no open pull requests'))
  }
  for (const pr of shown) {
    rows.push(boardRow(ui, pr, work.pr !== null && pr.number === work.pr.number))
  }
  if (boardRest > 0) {
    rows.push(ui.line([{ text: `+${boardRest} more`, color: MUTED }]))
  }
  if (unstarted !== null && unstarted.length > 0) {
    const assigned = totals?.assigned ?? unstarted.length
    const mine = unstarted.slice(0, MAX_UNSTARTED)

    rows.push(ui.subheader('Assigned to you', String(assigned)))
    for (const issue of mine) {
      const inPr = typeof issue.inPr === 'number' ? issue.inPr : null

      rows.push(
        ui.line([
          { text: refOf(issue.url, issue.number, work.repo), color: 'cyan' },
          { text: ` ${clean(issue.title)}`, min: 12 },
          ...dotted(
            [inPr === null ? { text: 'no PR yet', color: 'warning', drop: 1 } : { text: `PR #${inPr}`, color: MUTED, drop: 1 }],
            true,
          ),
        ]),
      )
    }
    if (assigned > mine.length) {
      rows.push(ui.line([{ text: `+${assigned - mine.length} more`, color: MUTED }]))
    }
  }

  return rows
}

/**
 * `#7`, or `widgets#7` for an item of another repository than the pane's:
 * the review and assigned lists span every repository of the owner.
 */
function refOf(url: string, number: number, home: string | null): string {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:issues|pull)\/\d+$/.exec(url)
  const repo = match === null ? null : `${match[1]}/${match[2]}`

  return repo === null || home === null || repo.toLowerCase() === home.toLowerCase() ? `#${number}` : `${clean(match?.[2] ?? '')}#${number}`
}

function queueRows(ui: Layout, work: Work, nowMs: number): RenderElement[] {
  const queue = work.reviewQueue

  if (queue === null) {
    return [ui.header('Review queue'), ui.empty('loading…')]
  }

  const waiting = work.totals?.reviewQueue ?? queue.length
  const shown = queue.slice(0, MAX_QUEUE)
  const rows = [ui.header('Review queue', waiting > 0 ? String(waiting) : '')]

  if (queue.length === 0) {
    rows.push(ui.empty('nothing to review'))
  }
  for (const pr of shown) {
    const age = ago(nowMs, Date.parse(pr.updatedAt))

    rows.push(
      ui.line([
        { text: refOf(pr.url, pr.number, work.repo), color: 'cyan' },
        { text: ` ${clean(pr.title)}`, min: 12 },
        ...dotted(
          [
            { text: clean(pr.author), color: MUTED, drop: 1 },
            { text: age, color: MUTED, drop: 2 },
          ],
          true,
        ),
      ]),
    )
  }
  if (waiting > shown.length) {
    rows.push(ui.line([{ text: `+${waiting - shown.length} more`, color: MUTED }]))
  }

  return rows
}

/**
 * The Work tab: the branch's repository, tickets, pull request and CI run, the team's open pull requests and
 * unstarted issues, and the reviews waiting on the person. `null`, and a Work the lane has not read yet, draw
 * "loading…"; a Work with a `problem` draws that and nothing from GitHub.
 */
export function workView(kit: Kit, work: Work | null, opts: WorkOptions): RenderElement {
  const { Box } = kit
  const ui = layout(kit, opts.width)
  const stack = (sections: readonly (readonly RenderElement[])[]): RenderElement => (
    <Box flexDirection="column" gap={1}>
      {sections.map(rows => (
        <Box flexDirection="column">{rows}</Box>
      ))}
    </Box>
  )

  if (work === null) {
    return stack([[ui.empty('loading…')]])
  }

  const isUnread = work.fetchedAt <= 0 && work.problem === null

  if (isUnread && work.repo === null && work.branch === null) {
    return stack([[ui.empty('loading…')]])
  }

  const head = [titleRow(ui, work, opts)]

  if (work.problem !== null) {
    return stack([head, problemRows(ui, work.problem, work.canRetry)])
  }
  if (isUnread) {
    return stack([head, [ui.empty('loading…')]])
  }

  return stack([
    head,
    ticketRows(ui, work.tickets),
    prRows(ui, work.pr, opts),
    ciRows(ui, work.ci, opts.nowMs),
    boardRows(ui, work),
    queueRows(ui, work, opts.nowMs),
  ])
}
