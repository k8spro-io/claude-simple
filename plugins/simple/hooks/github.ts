// The GitHub side of the mod as pure functions: where a remote points, which
// issues a branch names, the one read-only GraphQL query behind the status
// line's PR and CI and the Work pane (a single `gh api graphql` call a refresh,
// 1 rate-limit point), the argv that runs it, and what gh's answer means. No `$`
// and no clock here (time comes in as nowMs), so the lanes and the tests share
// it. A failed read never passes for "none found": see `parseAnswer`. Labels and
// assignees are not asked for, so the tickets and issues carry [] for both.

import type { Check, CheckOutcome, CiRun, Issue, IssueRef, MergeState, PullRequest, ReviewState } from './model'

type Json = Readonly<Record<string, unknown>>
type Verdict = PullRequest['reviews'][number]['state']

/** A git remote's address taken apart. */
export type Remote = { host: string; owner: string; name: string }

/** An issue number found for a branch, and where the link came from. */
export type TicketNumber = { number: number; source: IssueRef['source'] }

/** What one GitHub call asks for. */
export type QueryInput = {
  remote: Remote
  /** The branch's name on the remote: its upstream's, else the local one. */
  head: string
  /** False when HEAD is detached or on the default branch: no branch pull request or CI is asked for. */
  hasHead: boolean
  /** True while the Work pane is open: the team's pull requests, the review queue and the assigned issues too. */
  lists: boolean
  /** The issue numbers to look up (from `ticketNumbersOf`), each with where it came from. */
  refs: readonly TicketNumber[]
  /** `--cache <n>s` (gh keeps the answer on disk, shared by every session); null for a fresh call. */
  cacheSeconds: number | null
}

/** What one answer holds. */
export type GithubData = {
  /** `owner/name` as GitHub spells it. */
  repo: string
  /** The login gh is signed in as. */
  viewer: string
  /** The default branch's name; '' for a repository with no commit yet. */
  defaultBranch: string
  /** CI of the default branch's head commit; null when it has no checks. */
  defaultCi: CiRun | null
  /** The branch's open pull request: the one from this repository first, then one from a fork; null when none is open. */
  pr: PullRequest | null
  /** CI of the branch's head commit on the remote; null when it has no checks or has not been pushed. */
  ci: CiRun | null
  /** The issues the branch is on: those its pull request closes first, then the numbers looked up that are issues. */
  tickets: IssueRef[]
  /** The newest open pull requests of the repository, the branch's own left out; null when the lists were not asked for. */
  board: PullRequest[] | null
  /** Open pull requests asking the person (or a team of theirs) for a review, across the owner's repositories. */
  reviewQueue: PullRequest[] | null
  /** Open issues assigned to the person, across the owner's repositories. */
  assigned: Issue[] | null
  /** GitHub's own counts behind the three lists (the board's counts the branch's own pull request); null when not asked for. */
  totals: { board: number; reviewQueue: number; assigned: number } | null
}

/**
 * What a gh run means. `off`: only the person can fix it (not logged in, a
 * token GitHub refuses, a repository gh cannot see), so asking again changes
 * nothing. `trouble`: it may pass (offline, a rate limit, GitHub failing), so
 * the last answer stays and the lane asks again, at `retryAtMs` when GitHub
 * said when. The reasons are one short English line each, to draw as they are.
 */
export type GithubAnswer =
  | { kind: 'ok'; data: GithubData; resetAtMs: number | null }
  | { kind: 'off'; reason: string }
  | { kind: 'trouble'; reason: string; retryAtMs: number | null }

/** Longest title kept: GitHub's own limit for a pull request or issue title. */
const MAX_TITLE = 256
/** Longest login, label, check or team name kept. */
const MAX_NAME = 160
const MAX_BRANCH = 255
const MAX_URL = 2048
/** Most issues looked up and shown for a branch. */
const MAX_TICKETS = 5
/** The part of stderr, and of each error message, that `failureOf` reads: what matters is at the head. */
const MAX_STDERR = 8192
const MAX_MESSAGE = 1024
/** GraphQL's Int has 32 bits: a larger number in the query is a validation error, and no issue has it. */
const MAX_NUMBER = 2_147_483_647

/** What a check run concluded with, lowercased. */
const CONCLUSIONS = new Map<string, CheckOutcome>([
  ['success', 'passed'],
  ['failure', 'failed'],
  ['timed_out', 'failed'],
  ['cancelled', 'failed'],
  ['startup_failure', 'failed'],
  ['action_required', 'failed'],
  ['stale', 'failed'],
  ['skipped', 'skipped'],
  ['neutral', 'skipped'],
])
/** What a commit status (the older kind of check), or the whole rollup of a commit, says, lowercased. */
const STATES = new Map<string, CheckOutcome>([
  ['success', 'passed'],
  ['failure', 'failed'],
  ['error', 'failed'],
  ['pending', 'pending'],
  ['expected', 'pending'],
])
/** The statuses of a check run that is not done, lowercased. */
const RUN_PENDING = new Set(['queued', 'in_progress', 'waiting', 'requested', 'pending'])
const MERGES = new Map<string, MergeState>([
  ['CLEAN', 'clean'],
  ['BEHIND', 'behind'],
  ['DIRTY', 'dirty'],
  ['BLOCKED', 'blocked'],
  ['UNSTABLE', 'unstable'],
  ['HAS_HOOKS', 'clean'],
  ['DRAFT', 'draft'],
])
const VERDICTS = new Map<string, Verdict>([
  ['approved', 'approved'],
  ['changes_requested', 'changes_requested'],
  ['commented', 'commented'],
  ['dismissed', 'dismissed'],
  ['pending', 'pending'],
])

/**
 * Every environment variable that keeps gh quiet and parseable: no prompt, no
 * spinner, no update check (which would also write gh's state file), no pager,
 * no colour. The engine sets these over the person's own environment, where a
 * colour turned on would put escapes into the JSON: NO_COLOR wins over a forced
 * terminal (GH_FORCE_TTY), but not over CLICOLOR_FORCE, so that one is undone.
 */
export const GH_ENV: Readonly<Record<string, string>> = Object.freeze({
  GH_PROMPT_DISABLED: '1',
  GH_NO_UPDATE_NOTIFIER: '1',
  GH_NO_EXTENSION_UPDATE_NOTIFIER: '1',
  GH_SPINNER_DISABLED: '1',
  GH_PAGER: 'cat',
  NO_COLOR: '1',
  CLICOLOR_FORCE: '0',
})

// ---------------------------------------------------------------- remote

// `ssh://[user@]host[:port]/owner/name[.git][/]`, the same with `https://` or
// `http://` (and `user:token@`), and scp-like `[user@]host:owner/name[.git][/]`.
const URL_REMOTE = /^(?:ssh|https?):\/\/(?:[^/]*@)?([^/@]+)\/([^/]+)\/(.+?)(?:\.git)?\/?$/i
const SCP_REMOTE = /^(?:[^/@:\s]+@)?([^/@:\s]+):([^/]+)\/(.+?)(?:\.git)?\/?$/
const HOST = /^[a-z0-9][a-z0-9.-]*$/
/** What an owner or a name may be: it goes into a search query, so nothing that could add a qualifier. */
const SLUG = /^[A-Za-z0-9_.-]{1,100}$/

/**
 * A git remote's address as host, owner and name: `https://github.com/o/n`,
 * `ssh://git@github.com:22/o/n.git`, `git@github.com:o/n.git`, with or without
 * `.git` or a trailing slash, with a login (and a token) in front, and the
 * port left off. The host is lowercased. Null for anything else: no address, a
 * path of other than two parts, an owner or name outside `A-Za-z0-9_.-`.
 */
export function parseRemote(url: string | null | undefined): Remote | null {
  const text = typeof url === 'string' ? url.trim() : ''

  if (text === '' || text.length > MAX_URL) {
    return null
  }

  const match = URL_REMOTE.exec(text) ?? SCP_REMOTE.exec(text)
  const host = (match?.[1] ?? '').toLowerCase().replace(/:\d+$/, '')
  const owner = match?.[2] ?? ''
  const name = match?.[3] ?? ''

  return HOST.test(host) && SLUG.test(owner) && SLUG.test(name) ? { host, owner, name } : null
}

/** Whether the remote is on github.com. Version 1 asks nothing of another host: it could be GitLab, and gh would be asked about the wrong place. */
export function isGithub(remote: Remote | null | undefined): boolean {
  return remote !== null && remote !== undefined && remote.host === 'github.com'
}

// ---------------------------------------------------------------- tickets

/** A branch segment that starts with a number: `123-x`, `123`, `42_x`. Not `1.2.3`, not `3d`, not `007`. */
const BRANCH_BARE = /^([1-9]\d{0,5})(?=$|[-_])/
/** A branch segment that names an issue: `gh-123-x`, `GH_123`, `issue-123`, `issues-123`. */
const BRANCH_KEYED = /^(?:gh|issues?)[-_]([1-9]\d{0,5})(?=$|[-_])/i
/** `#123` as a reference: not inside a word (`repo#1`, `C#1`), a URL (`/a#1`, `/#1`) or an entity (`&#1;`). */
const COMMIT_REF = /(^|[^\p{L}\p{N}_&/#])#([1-9]\d{0,5})(?![\p{L}\p{N}_])/gu

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function positiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

/** A bare number that reads as a year (`2024-q4-plan`) is not an issue; one after `gh-` or `issue-` is. */
function isYear(n: number): boolean {
  return n >= 1900 && n <= 2099
}

/**
 * The issue numbers a branch name carries. Each `/`-separated part gives at
 * most one: a number it starts with and that ends it or is followed by `-` or
 * `_` (`feat/123-x`, `123-x`, `fix/42`), or one after `gh-`, `issue-` or
 * `issues-` in any case (`GH-123-x`). Never a number of more than six digits
 * (a date, a timestamp), one with a leading zero, a version (`1.2.3`), or a
 * bare year (1900-2099). Other words before a number (`fix-12`, `ABC-12`,
 * `feat/scale-90`) say nothing about GitHub, so they give none: a guess at an
 * issue is shown with its title, and a wrong one costs more than a missing one.
 */
function branchNumbers(branch: string): number[] {
  const numbers: number[] = []

  for (const part of branch.split('/')) {
    const keyed = BRANCH_KEYED.exec(part)?.[1]
    const bare = BRANCH_BARE.exec(part)?.[1]

    if (keyed !== undefined) {
      numbers.push(Number(keyed))
    } else if (bare !== undefined && !isYear(Number(bare))) {
      numbers.push(Number(bare))
    }
  }

  return numbers
}

/** The `#123` references in commit messages (subjects and bodies, any number of lines), in order of appearance. */
function commitNumbers(messages: string): number[] {
  return [...messages.matchAll(COMMIT_REF)].map(match => Number(match[2]))
}

/**
 * The issues a branch is on, with where each link came from: the branch's name
 * (`feat/123-x`, `gh-123`: see `branchNumbers`), the pull request's closing
 * issues, and `#123` in the commit messages (`Closes #123` and any other form;
 * not `repo#123` or a URL fragment). Ordered branch, then pr, then commit; an
 * issue found twice keeps the first source; at most five. `commitSubjects` is
 * any text of commit messages, one subject or a whole log.
 */
export function ticketNumbersOf(branch: string, commitSubjects: string, prCloses: readonly number[]): TicketNumber[] {
  const found: TicketNumber[] = []

  function add(number: number | null, source: IssueRef['source']): void {
    if (number !== null && found.length < MAX_TICKETS && !found.some(one => one.number === number)) {
      found.push({ number, source })
    }
  }

  for (const number of branchNumbers(str(branch))) {
    add(number, 'branch')
  }
  for (const number of prCloses) {
    add(positiveInt(number), 'pr')
  }
  for (const number of commitNumbers(str(commitSubjects))) {
    add(number, 'commit')
  }

  return found
}

// ---------------------------------------------------------------- the query

/** The numbers worth a lookup: positive whole numbers that fit GraphQL's Int, each once, at most five. */
function validRefs(numbers: readonly number[]): number[] {
  const valid = numbers.filter(n => Number.isSafeInteger(n) && n > 0 && n <= MAX_NUMBER)

  return [...new Set(valid)].slice(0, MAX_TICKETS)
}

/** The checks of a commit: the rollup's state and its first fifty contexts, check runs and commit statuses. */
const ROLLUP =
  'statusCheckRollup { state contexts(first: 50) { totalCount nodes { __typename ' +
  '... on CheckRun { name status conclusion startedAt completedAt detailsUrl } ' +
  '... on StatusContext { context state createdAt targetUrl } } } }'

/**
 * The one read-only query of a refresh. `refs` become aliased
 * `issueOrPullRequest` lookups (`r123`), and only ever as validated positive
 * whole numbers: nothing else is written into the text, and the owner, the
 * name and the branch travel as variables. What is asked for:
 * - always: the viewer, the rate limit, the default branch's name and its head
 *   commit's checks, the lookups;
 * - `$hasHead`: the branch's head commit's checks (`branch`) and its open
 *   pull requests (`head`: reviews, review requests, closing issues, checks,
 *   merge state);
 * - `$lists`: the repository's newest open pull requests (`team`, no checks:
 *   with them a big repository's answer runs to 300 KB and gets a 504), the
 *   review queue (`review`) and the assigned issues (`assigned`).
 * The cost is 1 point whatever is asked.
 */
export function buildQuery(refs: readonly number[]): string {
  const lookups = validRefs(refs).map(
    n =>
      `    r${n}: issueOrPullRequest(number: ${n}) { __typename ... on Issue { number title state url } ... on PullRequest { number } }`,
  )

  return `query Work($owner: String!, $name: String!, $head: String!, $headRef: String!, $hasHead: Boolean!, $lists: Boolean!, $qReview: String!, $qAssigned: String!) {
  viewer { login }
  rateLimit { cost remaining resetAt }
  repository(owner: $owner, name: $name) {
    nameWithOwner
    defaultBranchRef { name target { ... on Commit { oid ${ROLLUP} } } }
    branch: ref(qualifiedName: $headRef) @include(if: $hasHead) { target { ... on Commit { oid ${ROLLUP} } } }
    head: pullRequests(headRefName: $head, states: OPEN, first: 3, orderBy: {field: UPDATED_AT, direction: DESC}) @include(if: $hasHead) {
      nodes { ...Pr state isCrossRepository baseRefName mergeStateStatus autoMergeRequest { enabledAt }
        reviewRequests(first: 4) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug } ... on Bot { login } ... on Mannequin { login } } } }
        latestReviews(first: 4) { nodes { state author { login } } }
        closingIssuesReferences(first: 4) { nodes { number title state url repository { nameWithOwner } } }
        ${ROLLUP} }
    }
    team: pullRequests(states: OPEN, first: 8, orderBy: {field: UPDATED_AT, direction: DESC}) @include(if: $lists) {
      totalCount
      nodes { ...Pr closingIssuesReferences(first: 2) { nodes { number repository { nameWithOwner } } } }
    }
${lookups.join('\n')}
  }
  review: search(query: $qReview, type: ISSUE, first: 5) @include(if: $lists) { issueCount nodes { ...Pr } }
  assigned: search(query: $qAssigned, type: ISSUE, first: 5) @include(if: $lists) {
    issueCount
    nodes { ... on Issue { number title url updatedAt closedByPullRequestsReferences(first: 1, includeClosedPrs: false) { nodes { number } } } }
  }
}
fragment Pr on PullRequest { number title url isDraft reviewDecision author { login } headRefName updatedAt }`
}

/**
 * The argv for `$.process.run`: no shell, every value its own argument. Text
 * from outside (the branch) goes only through `-f`, which gh takes as it is;
 * `-F` would read `@file` and `{owner}` in a value, so it carries only the two
 * flags written here. The owner and the name must be what `parseRemote` gives
 * (they also scope the two searches): anything else throws a RangeError. A
 * fractional `cacheSeconds` is rounded down; one below a second, or not a
 * number, is a fresh call, and so is `hasHead` with an empty `head`.
 */
export function ghArgv(input: QueryInput): string[] {
  const { remote } = input

  if (!SLUG.test(remote.owner) || !SLUG.test(remote.name)) {
    throw new RangeError(`ghArgv: ${remote.owner}/${remote.name} is not a GitHub repository`)
  }

  const hasHead = input.hasHead && input.head !== ''
  const cache = input.cacheSeconds === null ? 0 : Math.floor(input.cacheSeconds)
  const scope = `user:${remote.owner}`

  return [
    'gh',
    'api',
    'graphql',
    // Pinned: GH_HOST, or gh logged in to one other host only, would send the query there.
    '--hostname',
    'github.com',
    ...(Number.isSafeInteger(cache) && cache >= 1 ? ['--cache', `${cache}s`] : []),
    '-f',
    `query=${buildQuery(input.refs.map(ref => ref.number))}`,
    '-f',
    `owner=${remote.owner}`,
    '-f',
    `name=${remote.name}`,
    '-f',
    `head=${hasHead ? input.head : ''}`,
    '-f',
    `headRef=${hasHead ? `refs/heads/${input.head}` : ''}`,
    '-F',
    `hasHead=${String(hasHead)}`,
    '-F',
    `lists=${String(input.lists)}`,
    '-f',
    `qReview=${scope} is:pr is:open review-requested:@me archived:false sort:updated-desc`,
    '-f',
    `qAssigned=${scope} is:issue is:open assignee:@me archived:false sort:updated-desc`,
  ]
}

// ---------------------------------------------------------------- text

// Only the escapes that start with ESC. A one-byte C1 introducer (U+009B, U+009D)
// in text from GitHub is far more likely a mis-decoded quote than a terminal
// command: it goes with the other controls, and not the text after it.
const ESCAPES = new RegExp(
  [
    // CSI: colours, cursor moves.
    String.raw`\u001b\[[0-?]*[ -/]*[@-~]`,
    // OSC: titles, hyperlinks; ended by BEL or ST.
    String.raw`\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?`,
    // DCS, SOS, PM, APC: strings ended by ST.
    String.raw`\u001b[PX^_][^\u001b]*(?:\u001b\\)?`,
    // Any other escape: charset designation, keypad mode.
    String.raw`\u001b[ -/]*[0-~]`,
  ].join('|'),
  'g',
)
/** Controls that separate words: they become a space, not nothing. */
const BREAKS = /[\t\n\v\f\r\u0085]/g
/** Control, format (bidi, zero-width, BOM, soft hyphen, tags) and lone-surrogate characters. */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Cs}]/gu
const SAFE_URL = /^https?:\/\/[^\s\p{Cc}\p{Cf}\p{Cs}]+$/u
/** RFC 3339, the only way GitHub writes a time: seconds, an optional fraction, then `Z` or an offset. */
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/

/**
 * Text from outside, fit for the engine to draw: escape sequences, control,
 * bidi and zero-width characters removed (any of them in a `Text` makes the
 * engine refuse the whole tree), whitespace collapsed to single spaces, and
 * cut to at most `max` characters (200 unless said), the last being `…` when
 * it was cut. Never splits a surrogate pair. Anything but a string, or a `max`
 * below 1, gives ''.
 */
export function clean(text: unknown, max = 200): string {
  const plain = (typeof text === 'string' ? text : '')
    .replace(ESCAPES, '')
    .replace(BREAKS, ' ')
    .replace(INVISIBLE, '')
    .replace(/\s+/g, ' ')
    .trim()
  const limit = Math.floor(max)

  if (!(limit >= 1)) {
    return ''
  }

  // By code point, so a cut never lands inside an emoji.
  const chars = Array.from(plain)

  if (chars.length <= limit) {
    return plain
  }

  const kept = chars.slice(0, limit - 1).join('')

  return `${kept.trimEnd()}…`
}

function parseJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout) as unknown
  } catch {
    return undefined
  }
}

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function record(value: unknown): Json {
  return isObject(value) ? value : {}
}

function arrayOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

function lower(value: unknown): string {
  return str(value).trim().toLowerCase()
}

/** A count from GitHub: a whole number from zero up, else 0. */
function count(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)]
}

/** A link GitHub gave, or '' when it is not a plain http(s) URL (it may become a hyperlink). */
function urlOf(value: unknown): string {
  const url = str(value)

  return url.length <= MAX_URL && SAFE_URL.test(url) ? url : ''
}

/**
 * A timestamp as GitHub wrote it, or '' when it is not one. `Date.parse` alone
 * also takes looser text, control characters and all (`Oct\u00077 2026`), which
 * would then be passed on.
 */
function stampOf(value: unknown): string {
  const stamp = str(value)

  return STAMP.test(stamp) && Number.isFinite(Date.parse(stamp)) ? stamp : ''
}

/** A timestamp as epoch ms; null when it is not one, or reads as the year 1 (a time that was never set). */
function epochOf(value: unknown): number | null {
  const ms = Date.parse(stampOf(value))

  return Number.isFinite(ms) && ms > 0 ? ms : null
}

/** The login of an `author`-like object; GitHub's name for a deleted account when it has none. */
function loginOf(value: unknown): string {
  return clean(record(value).login, MAX_NAME) || 'ghost'
}

// ---------------------------------------------------------------- checks and CI

/** One check of a commit: a check run by its name, a commit status by its context. */
type Entry = {
  name: string
  outcome: CheckOutcome
  /** Still going: queued, waiting or in progress, or a status that is pending or expected. */
  isRunning: boolean
  startedMs: number | null
  endedMs: number | null
  url: string
}

function entryOf(node: unknown): Entry | null {
  const item = record(node)
  const isStatus = item.__typename === 'StatusContext' || (item.__typename === undefined && 'context' in item)
  const name = clean(isStatus ? item.context : item.name, MAX_NAME)

  if (name === '') {
    return null
  }
  if (isStatus) {
    const state = lower(item.state)
    const isRunning = state === 'pending' || state === 'expected'
    const at = epochOf(item.createdAt)

    return {
      name,
      outcome: STATES.get(state) ?? 'pending',
      isRunning,
      startedMs: at,
      endedMs: isRunning ? null : at,
      url: urlOf(item.targetUrl),
    }
  }

  // Anything not known to have passed, failed or been skipped is pending, never passed.
  const status = lower(item.status)
  const isRunning = RUN_PENDING.has(status)
  const outcome =
    isRunning || (status !== '' && status !== 'completed')
      ? 'pending'
      : (CONCLUSIONS.get(lower(item.conclusion)) ?? 'pending')

  return {
    name,
    outcome,
    isRunning,
    startedMs: epochOf(item.startedAt),
    endedMs: epochOf(item.completedAt),
    url: urlOf(item.detailsUrl),
  }
}

/** When a run began, to tell a re-run from the run it replaces: one that has not started yet is the newest. */
function recency(entry: Entry): number {
  return entry.startedMs ?? (entry.isRunning ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY)
}

/**
 * The checks of a commit from its rollup's `contexts`: one entry per check
 * name, the newest run kept (as `gh pr checks` folds a re-run), in the order
 * the names first appear. Entries with no name, and non-objects, are left out.
 * `isPartial` when GitHub has more contexts than the fifty it was asked for.
 */
function entriesOf(contexts: unknown): { entries: Entry[]; isPartial: boolean } {
  const nodes = arrayOf(record(contexts).nodes)
  const newest = new Map<string, Entry>()

  for (const node of nodes) {
    const entry = entryOf(node)
    const held = entry === null ? undefined : newest.get(entry.name)

    if (entry !== null && (held === undefined || recency(entry) >= recency(held))) {
      newest.set(entry.name, entry)
    }
  }

  return { entries: [...newest.values()], isPartial: count(record(contexts).totalCount) > nodes.length }
}

/** Failed if any failed, else pending if any is, else skipped when every one was, else passed; undefined for none. */
function worstOf(entries: readonly Entry[]): CheckOutcome | undefined {
  if (entries.length === 0) {
    return undefined
  }
  if (entries.some(entry => entry.outcome === 'failed')) {
    return 'failed'
  }
  if (entries.some(entry => entry.outcome === 'pending')) {
    return 'pending'
  }

  return entries.every(entry => entry.outcome === 'skipped') ? 'skipped' : 'passed'
}

/** The worse of what the checks read say and what the rollup's own state says: a failure outranks a wait. */
function worse(read: CheckOutcome, state: CheckOutcome | undefined): CheckOutcome {
  if (read === 'failed' || state === undefined || state === 'passed') {
    return read
  }

  return state
}

/**
 * The CI of a commit, from the commit as the query asks for it (`{ oid,
 * statusCheckRollup }`; a rollup by itself reads the same, with no `sha`). Each
 * check name counts once, by its newest run.
 * - `outcome`: failed if any check failed, else pending if any is, else skipped
 *   when every check was, else passed. With more checks than were read (fifty)
 *   the rollup's own state is added: a failure or a wait beyond them counts.
 * - `isRunning`: a check run is queued, waiting or in progress, or a commit
 *   status is pending or expected. Alone, that is `pending` (and `failed` stays
 *   `failed` while another check runs).
 * - `workflow`: the first failing check's name when failed, else the first
 *   running one's; '' when neither names one. `url` is that check's link.
 * - `at`, epoch ms: while running, when the earliest running check started
 *   (`nowMs` when none says, else 0); else when the last check ended; 0 when
 *   unknown.
 * - `sha`: the first seven characters of the commit.
 * Null when the commit has no rollup (no checks).
 */
export function ciOf(commit: unknown, nowMs?: number): CiRun | null {
  const item = record(commit)
  const rollup = record('statusCheckRollup' in item ? item.statusCheckRollup : item)
  const { entries, isPartial } = entriesOf(rollup.contexts)
  const read = worstOf(entries)
  const state = STATES.get(lower(rollup.state))
  const outcome = read === undefined ? state : isPartial ? worse(read, state) : read

  if (outcome === undefined) {
    return null
  }

  const running = entries.filter(entry => entry.isRunning)
  const isRunning = running.length > 0
  const named = outcome === 'failed' ? entries.find(entry => entry.outcome === 'failed') : running[0]
  const started = running.flatMap(entry => (entry.startedMs === null ? [] : [entry.startedMs]))
  const ended = entries.flatMap(entry => (entry.endedMs === null ? [] : [entry.endedMs]))
  const unknown = typeof nowMs === 'number' && Number.isFinite(nowMs) ? nowMs : 0
  // Folded, not spread into Math.min: a list of a million (garbage from gh) as arguments throws a RangeError.
  const at = isRunning
    ? started.length > 0
      ? started.reduce((earliest, ms) => Math.min(earliest, ms))
      : unknown
    : ended.length > 0
      ? ended.reduce((latest, ms) => Math.max(latest, ms))
      : 0
  const oid = str(item.oid)

  return {
    workflow: named?.name ?? '',
    outcome,
    isRunning,
    at,
    url: named?.url ?? '',
    sha: /^[0-9a-f]{7,64}$/i.test(oid) ? oid.slice(0, 7) : '',
  }
}

// ---------------------------------------------------------------- pull requests and issues

/**
 * What the reviews add up to. A draft is a draft, whatever was said; no
 * decision (the repository asks for no review) is null.
 */
function reviewOf(decision: unknown, isDraft: boolean): ReviewState | null {
  if (isDraft) {
    return 'draft'
  }

  switch (str(decision).trim().toUpperCase()) {
    case 'APPROVED':
      return 'approved'
    case 'CHANGES_REQUESTED':
      return 'changes_requested'
    case 'REVIEW_REQUIRED':
      return 'pending'
    default:
      return null
  }
}

/** Whether the pull request can merge. GitHub reports a draft as blocked, so the draft flag decides first. */
function mergeOf(mergeStateStatus: unknown, isDraft: boolean): MergeState {
  return isDraft ? 'draft' : (MERGES.get(str(mergeStateStatus).trim().toUpperCase()) ?? 'unknown')
}

/** Who was asked to review and has not answered, from `reviewRequests`: a login, or a team's `@slug`. */
function reviewersOf(requests: unknown): string[] {
  const names = arrayOf(record(requests).nodes).map(node => {
    const who = record(record(node).requestedReviewer)
    const isTeam = who.__typename === 'Team' || (who.login === undefined && who.slug !== undefined)
    const name = clean(isTeam ? who.slug : who.login, MAX_NAME)

    return isTeam && name !== '' ? `@${name}` : name
  })

  return unique(names.filter(name => name !== ''))
}

/** The latest review of each reviewer, from `latestReviews`; a state GitHub has not defined is left out. */
function reviewsOf(latest: unknown): PullRequest['reviews'] {
  const reviews: PullRequest['reviews'] = []
  const seen = new Set<string>()

  for (const node of arrayOf(record(latest).nodes)) {
    const item = record(node)
    const state = VERDICTS.get(lower(item.state))
    const author = loginOf(item.author)

    if (state !== undefined && !seen.has(author)) {
      seen.add(author)
      reviews.push({ author, state })
    }
  }

  return reviews
}

/**
 * The issues a pull request closes in its own repository (`home`, lowercased):
 * an issue elsewhere is not one of ours, and a number alone cannot say which.
 * One that does not say where it is is left out with them.
 */
function closingOf(item: Json, home: string): Json[] {
  return arrayOf(record(item.closingIssuesReferences).nodes)
    .map(record)
    .filter(node => positiveInt(node.number) !== null && lower(record(node.repository).nameWithOwner) === home)
}

/**
 * A pull request as the query's `Pr` fragment gives it, and more when the
 * query asked for more (the branch's own has reviews, checks and a merge state;
 * a row of a list has none, so its `checks` is [] and its `merge` unknown: an
 * empty `checks` there is not "no checks"). Null when it has no number.
 */
function pullRequestOf(node: unknown, home: string): PullRequest | null {
  const item = record(node)
  const number = positiveInt(item.number)

  if (number === null) {
    return null
  }

  const isDraft = item.isDraft === true
  const closes = closingOf(item, home).map(issue => positiveInt(issue.number) ?? 0)

  return {
    number,
    title: clean(item.title, MAX_TITLE),
    url: urlOf(item.url),
    author: loginOf(item.author),
    branch: clean(item.headRefName, MAX_BRANCH),
    isDraft,
    review: reviewOf(item.reviewDecision, isDraft),
    reviewers: reviewersOf(item.reviewRequests),
    reviews: reviewsOf(item.latestReviews),
    checks: entriesOf(record(item.statusCheckRollup).contexts).entries.map((entry): Check => ({
      name: entry.name,
      outcome: entry.outcome,
    })),
    merge: mergeOf(item.mergeStateStatus, isDraft),
    ...(typeof item.baseRefName === 'string' && item.baseRefName !== '' ? { base: clean(item.baseRefName, MAX_BRANCH) } : {}),
    isAutoMerge: isObject(item.autoMergeRequest),
    closes: unique(closes),
    updatedAt: stampOf(item.updatedAt),
  }
}

/** An issue as a ticket linked from `source`; null when it has no number. */
function ticketOf(node: unknown, source: IssueRef['source']): IssueRef | null {
  const item = record(node)
  const number = positiveInt(item.number)
  const state = lower(item.state)

  if (number === null) {
    return null
  }

  return {
    number,
    title: clean(item.title, MAX_TITLE),
    state: state === 'open' || state === 'closed' ? state : '',
    url: urlOf(item.url),
    labels: [],
    assignees: [],
    source,
  }
}

/** An issue of the assigned list, with the open pull request that closes it when GitHub knows one; null when it has no number. */
function issueOf(node: unknown): Issue | null {
  const item = record(node)
  const number = positiveInt(item.number)

  if (number === null) {
    return null
  }

  return {
    number,
    title: clean(item.title, MAX_TITLE),
    url: urlOf(item.url),
    assignees: [],
    labels: [],
    updatedAt: stampOf(item.updatedAt),
    inPr: positiveInt(record(arrayOf(record(item.closedByPullRequestsReferences).nodes)[0]).number),
  }
}

function present<T>(value: T | null): value is T {
  return value !== null
}

// ---------------------------------------------------------------- the answer

const NOT_SET_UP = 'gh is not set up here'
const NOT_LOGGED_IN_REASON = 'gh is not logged in: run gh auth login'
const REJECTED_REASON = 'gh credentials were rejected: run gh auth login'
const UNREACHABLE_REASON = 'GitHub is not reachable'
const RATE_LIMITED_REASON = 'GitHub rate limit reached'
const ERROR_REASON = 'GitHub answered with an error'

const RATE_LIMIT = /rate limit|abuse detection|HTTP 429|too many requests/i
const REJECTED = /bad credentials|HTTP 401/i
const NOT_LOGGED_IN = /gh auth login|authentication required|not logged in/i
const OFFLINE =
  /error connecting to|i\/o timeout|dial tcp|no such host|TLS handshake|connection refused|connection reset|network is unreachable|proxyconnect|deadline exceeded|timeout awaiting/i

/** What a run that gave no usable answer left behind. */
type Failure = {
  exitCode: number
  /** What gh and GitHub said: stderr, the message of the body, the messages of the errors. */
  said: string
  /** An error of type RATE_LIMITED came back. */
  isRateLimited: boolean
  /** The repository came back null: it does not exist, or the token cannot see it. */
  hasNoAccess: boolean
  /** `rateLimit.resetAt` as epoch ms, when the answer had it. */
  resetAtMs: number | null
}

/**
 * A failed read, by what gh and GitHub said. The order matters: a rate-limit
 * text can offer `gh auth login` as well, and so can a refused token. Matches
 * the texts gh 2.97 printed when each case was provoked, except the rate-limit
 * ones, which are GitHub's documented messages (a limit cannot be reached on
 * purpose to read them). A 502 or 504 is GitHub answering, so it is an error
 * and not a network failure.
 */
function failureOf(failure: Failure, remote: Remote): GithubAnswer {
  const { exitCode, said } = failure

  // Only a shim or a wrapper exits like this (a version manager with no version set): there is no gh to ask.
  if (exitCode === 126 || exitCode === 127) {
    return { kind: 'off', reason: NOT_SET_UP }
  }
  if (failure.isRateLimited || RATE_LIMIT.test(said)) {
    return { kind: 'trouble', reason: RATE_LIMITED_REASON, retryAtMs: failure.resetAtMs }
  }
  if (REJECTED.test(said)) {
    return { kind: 'off', reason: REJECTED_REASON }
  }
  // gh exits 4 when a command needs a login.
  if (exitCode === 4 || NOT_LOGGED_IN.test(said)) {
    return { kind: 'off', reason: NOT_LOGGED_IN_REASON }
  }
  if (failure.hasNoAccess) {
    return { kind: 'off', reason: `gh cannot see ${clean(`${remote.owner}/${remote.name}`, MAX_NAME)}` }
  }
  if (OFFLINE.test(said)) {
    return { kind: 'trouble', reason: UNREACHABLE_REASON, retryAtMs: null }
  }

  return { kind: 'trouble', reason: ERROR_REASON, retryAtMs: null }
}

/** A ticket number that names nothing comes back as NOT_FOUND at `repository.rN`: the one error the rest of the answer survives. */
function isMissingRef(error: Json, asked: ReadonlySet<string>): boolean {
  const path = arrayOf(error.path)
  const alias = path[1]

  return (
    error.type === 'NOT_FOUND' &&
    path.length === 2 &&
    path[0] === 'repository' &&
    typeof alias === 'string' &&
    asked.has(alias)
  )
}

/** The list a search or a connection gave, or null when it did not come (so that an unread list is not an empty one). */
function listOf(piece: unknown): readonly unknown[] | null {
  return isObject(piece) && Array.isArray(piece.nodes) ? piece.nodes : null
}

function dataOf(data: Json, repository: Json, input: QueryInput): GithubData {
  const given = str(repository.nameWithOwner)
  const repo = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(given) ? given : `${input.remote.owner}/${input.remote.name}`
  const home = repo.toLowerCase()

  // The branch's open pull request: from this repository first, then from a fork (a branch name can be on both).
  const open = arrayOf(record(repository.head).nodes)
    .map(record)
    .filter(node => lower(node.state) === 'open')
  const picked = open.find(node => node.isCrossRepository !== true) ?? open[0]
  const pr = pullRequestOf(picked, home)

  // The pull request's closing issues, then the numbers looked up that are issues; each issue once, at most five.
  const sources = new Map<number, IssueRef['source']>()

  for (const ref of input.refs) {
    if (!sources.has(ref.number)) {
      sources.set(ref.number, ref.source)
    }
  }

  const closing = picked === undefined ? [] : closingOf(picked, home).map(node => ticketOf(node, 'pr'))
  const looked = validRefs(input.refs.map(ref => ref.number)).map(number => {
    const found = record(repository[`r${number}`])

    return found.__typename === 'Issue' ? ticketOf(found, sources.get(number) ?? 'commit') : null
  })
  const tickets: IssueRef[] = []

  for (const ticket of [...closing, ...looked].filter(present)) {
    if (tickets.length < MAX_TICKETS && !tickets.some(one => one.number === ticket.number)) {
      tickets.push(ticket)
    }
  }

  const team = input.lists ? listOf(repository.team) : null
  const review = input.lists ? listOf(data.review) : null
  const assigned = input.lists ? listOf(data.assigned) : null

  return {
    repo,
    viewer: clean(record(data.viewer).login, MAX_NAME),
    defaultBranch: clean(record(repository.defaultBranchRef).name, MAX_BRANCH),
    defaultCi: ciOf(record(repository.defaultBranchRef).target),
    pr,
    ci: ciOf(record(repository.branch).target),
    tickets,
    board:
      team === null
        ? null
        : team
            .map(node => pullRequestOf(node, home))
            .filter(present)
            .filter(row => row.number !== pr?.number),
    reviewQueue: review === null ? null : review.map(node => pullRequestOf(node, home)).filter(present),
    assigned: assigned === null ? null : assigned.map(issueOf).filter(present),
    totals: input.lists
      ? {
          board: count(record(repository.team).totalCount),
          reviewQueue: count(record(data.review).issueCount),
          assigned: count(record(data.assigned).issueCount),
        }
      : null,
  }
}

/**
 * What a gh run printed, as the answer to the query of `ghArgv(input)`. Never
 * throws. gh exits 1 when the answer carries `errors` and still prints the
 * `data` that came, so stdout is read whatever the exit code is.
 * - ok: the repository came back and every error is a ticket number that names
 *   nothing (`NOT_FOUND` at `repository.rN` for an N asked): that ticket is
 *   left out and the rest stays. Any other error, even beside data, fails the
 *   whole answer: a part GitHub could not read must not read as empty (and an
 *   `errors` that is not a list is one nobody can read).
 * - a list the lanes asked for that did not come is null, not []. When
 *   `lists` was false the three lists and the totals are null.
 * - off, by what was said: exit 126 or 127; a token GitHub refuses (401,
 *   Bad credentials); exit 4 or a text asking for `gh auth login`; a
 *   repository that came back null (it does not exist, or the token cannot see it).
 * - trouble: a rate limit (`RATE_LIMITED`, "rate limit", 429), with
 *   `retryAtMs` from `rateLimit.resetAt` when the answer has it; a network
 *   failure; anything else, and garbage.
 */
export function parseAnswer(stdout: string, exitCode: number, stderr: string, input: QueryInput): GithubAnswer {
  const doc = record(parseJson(stdout))
  const data = record(doc.data)
  const errors = arrayOf(doc.errors).map(record)
  // `errors` that is not a list (some servers send null for none) is an error nobody can read: not a clean answer.
  const isGarbled = doc.errors !== undefined && doc.errors !== null && !Array.isArray(doc.errors)
  const repository = data.repository
  const asked = new Set(validRefs(input.refs.map(ref => ref.number)).map(number => `r${number}`))
  const resetAtMs = epochOf(record(data.rateLimit).resetAt)

  if (!isGarbled && isObject(repository) && errors.every(error => isMissingRef(error, asked))) {
    return { kind: 'ok', data: dataOf(data, repository, input), resetAtMs }
  }

  // A body that is not GraphQL (a refused token, a secondary rate limit) says it in `message` and `status`.
  const status = typeof doc.status === 'string' || typeof doc.status === 'number' ? `HTTP ${doc.status}` : ''
  const said = [
    (typeof stderr === 'string' ? stderr : '').slice(0, MAX_STDERR),
    str(doc.message).slice(0, MAX_MESSAGE),
    status,
    ...errors.slice(0, 10).map(error => str(error.message).slice(0, MAX_MESSAGE)),
  ].join('\n')

  return failureOf(
    {
      exitCode,
      said,
      isRateLimited: errors.some(error => error.type === 'RATE_LIMITED'),
      hasNoAccess: repository === null,
      resetAtMs,
    },
    input.remote,
  )
}
