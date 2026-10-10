// The refresh lanes behind the status line and the Work pane. Hooks only note
// what happened and kick a lane; each lane runs from a timer, one run at a
// time with one trailing re-run, and keeps what it measured here for the
// render hooks to draw. No tool result, prompt or turn ever waits on git, gh
// or python3, and GitHub is asked only while its answer is on screen (the
// status line's PR and CI, or the Work pane placed): one read-only GraphQL
// call per refresh, shared by the status line and the pane. An idle session
// (no prompt, turn or tool call for ten minutes) refreshes five times slower.

import type { Timer, TurnUsage } from 'claude-code'

import {
  GH_ENV,
  ghArgv,
  isGithub,
  parseAnswer,
  parseRemote,
  ticketNumbersOf,
  type GithubData,
  type QueryInput,
  type Remote,
} from './github'
import type { Host } from './host'
import type { CiRun, Work } from './model'
import {
  baseName,
  isSame,
  parseNumstat,
  parseStatus,
  placeOf,
  rowsOf,
  usageOf,
  weeklyOf,
  type Row,
  type StatusPr,
  type StatusSession,
  type StatusUsage,
  type StatusWeekly,
  type StatusWhere,
} from './statusline-format'

export type LaneName = 'git' | 'usage' | 'github' | 'weekly'

export type LaneOptions = {
  /** Draw the status line. */
  hasStatusLine: boolean
  /** Run python3 for the 7-day per-model totals. */
  hasWeekly: boolean
  /** Show the branch's pull request and CI in the status line (asks GitHub). */
  hasPr: boolean
  /** The Work pane exists: tickets, the team board and the review queue while it is open. */
  hasWork: boolean
}

export type CompactState = 'idle' | 'armed' | 'running'

type Lane = { timer: Timer | null; isRunning: boolean; isDirty: boolean }

/** The working tree the session is in, as the git lane last read it. */
type Repo = {
  top: string
  branch: string
  isDetached: boolean
  /** The branch's name on its remote: its upstream's, else the local one. */
  head: string
  remote: Remote | null
}

export const LANES: readonly LaneName[] = ['git', 'usage', 'github', 'weekly']

/** How long a kick waits before its lane runs, so a burst of kicks runs it once. */
const DELAY_MS: Record<LaneName, number> = { git: 400, usage: 100, github: 1500, weekly: 3000 }
const TICK_MS = 5000
/** git and usage again every 12 ticks (a minute); the weekly totals every 24 (two minutes). */
const GIT_TICKS = 12
const WEEKLY_TICKS = 24
/** With nothing happening for this long the session is idle, and every lane runs IDLE_FACTOR times less often. */
const IDLE_MS = 10 * 60_000
const IDLE_FACTOR = 5
/** GitHub on a timer: every two minutes, every minute while a check or a CI run is going. */
const GITHUB_EVERY_MS = 120_000
const GITHUB_BUSY_MS = 60_000
/** gh's own on-disk cache for timer refreshes, shared by every session on the same branch. */
const CACHE_S = 110
const BUSY_CACHE_S = 55
/** A fresh call (open, push, branch change, refresh) waits for this since the last one. */
const FRESH_GAP_MS = 15_000
const MAX_CALLS_PER_HOUR = 120
/** After a transient failure: 2, 4, 8, 16, then 30 minutes. */
const BACKOFF_MS = [120_000, 240_000, 480_000, 960_000, 1_800_000]
const GIT_TIMEOUT_MS = 5000
const GH_TIMEOUT_MS = 20_000
const WEEKLY_TIMEOUT_MS = 120_000
const WEEKLY_MAX_AGE_S = 120
const COMPACT_CONFIRM_MS = 5000
const COMPACT_MAX_MS = 10 * 60_000
const MAX_SUBJECTS = 50
const BASE_REFS = ['origin/HEAD', 'origin/main', 'origin/master', 'main', 'master']
const NO_SESSION: StatusSession = { effort: null, agent: null, cacheRead: 0, cacheWrite: 0, uncached: 0 }
const LEGACY_KEY = 'legacyStatusLineNotice'
export const LEGACY_NOTICE =
  'simple: your settings still run the old statusline.py, so two status lines draw. ' +
  'Run /simple:setup to remove it, or delete "statusLine" from ~/.claude/settings.json.'

/** A `$.process.run` whose command is not installed: asking again cannot help until it is. */
function isMissing(error: unknown): boolean {
  return /failed to start/i.test(String(error)) && /ENOENT|not found/i.test(String(error))
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** The command of a settings `statusLine` that runs the old statusline.py, else null. */
export function legacyCommandOf(statusLine: unknown): string | null {
  if (typeof statusLine !== 'object' || statusLine === null) {
    return null
  }

  const command = (statusLine as { command?: unknown }).command

  return typeof command === 'string' && /statusline\.py\b/.test(command) ? command : null
}

/** What a Bash result's `gitOperation` says: a push, or a pull request command. */
export function gitOperationOf(result: unknown): { isPush: boolean; isPr: boolean } {
  const operation =
    typeof result === 'object' && result !== null ? (result as { gitOperation?: unknown }).gitOperation : undefined

  if (typeof operation !== 'object' || operation === null) {
    return { isPush: false, isPr: false }
  }

  const { push, pr } = operation as { push?: unknown; pr?: unknown }

  return { isPush: push !== undefined, isPr: pr !== undefined }
}

/** Whether a CI run or a pull request's checks are still going: GitHub is then asked twice as often. */
function isGoing(data: GithubData | null, isOnDefault: boolean): boolean {
  return (
    data !== null &&
    (data.ci?.isRunning === true ||
      (isOnDefault && data.defaultCi?.isRunning === true) ||
      data.pr?.checks.some(check => check.outcome === 'pending') === true)
  )
}

/** Whether two reads of the working tree name the same place: same tree, branch, remote and name there. */
function isSamePlace(a: Repo, b: Repo): boolean {
  return a.top === b.top && a.branch === b.branch && a.head === b.head && isSame(a.remote, b.remote)
}

export function createLanes(options: LaneOptions) {
  const lanes: Record<LaneName, Lane> = {
    git: { timer: null, isRunning: false, isDirty: false },
    usage: { timer: null, isRunning: false, isDirty: false },
    github: { timer: null, isRunning: false, isDirty: false },
    weekly: { timer: null, isRunning: false, isDirty: false },
  }
  const baseRefs = new Map<string, string>()
  let host: Host | null = null
  let tick: Timer | null = null
  let ticks = 0
  let lastCwd: string | null = null
  let repo: Repo | null = null
  let subjects = ''
  // What the lanes measured.
  let where: StatusWhere | null = null
  let usage: StatusUsage | null = null
  let session: StatusSession = NO_SESSION
  let weekly: StatusWeekly | null = null
  let hasNerdFont = false
  let github: GithubData | null = null
  let fetchedAt = 0
  let problem: string | null = null
  /** Whether the refresh button can clear `problem`. */
  let canRetry = false
  /** The upstream may have changed (a push sets one): read the remote again at the next git run. */
  let isRemoteStale = false
  /** When something last happened in the session; idle sessions refresh less often. */
  let lastActivityAt = 0
  // When GitHub is asked again.
  let hasGh = true
  let isQuiet = false
  let isOffUntilAsked = false
  let isWorkOpen = false
  /** A surface that draws the status line is attached (the terminal, the desktop app); an editor's draws panes alone. */
  let isLineSeen = false
  let wantsFresh = false
  let lastCallAt = 0
  let lastFreshAt = 0
  let retryAt = 0
  let failures = 0
  let calls: number[] = []
  let hasPython = true
  let budget: number | null = null
  let budgetModel = ''
  let isBudgetStale = true
  let compact: CompactState = 'idle'
  let compactTimer: Timer | null = null
  /** The engine's clock against this process's: zero in a session, the test's mocked time in a test. */
  let clockOffset = 0

  function show(): void {
    host?.invalidate()
  }

  /** Now, on the engine's clock, without a round trip: synced each tick and before each GitHub call. */
  function now(): number {
    return Date.now() + clockOffset
  }

  async function syncClock(bound: Host): Promise<number> {
    const at = await bound.now()

    clockOffset = at - Date.now()

    return at
  }

  /** Returns `next`, and redraws, when it differs from `now`. */
  function changed<T>(now: T, next: T): T {
    if (isSame(now, next)) {
      return now
    }
    show()

    return next
  }

  function kick(name: LaneName): void {
    const bound = host
    const lane = lanes[name]

    if (bound === null) {
      return
    }
    lane.isDirty = true
    if (lane.timer !== null || lane.isRunning) {
      return
    }
    lane.timer = bound.after(DELAY_MS[name], () => {
      lane.timer = null
      void flush(name)
    })
  }

  function kickAll(): void {
    for (const name of LANES) {
      kick(name)
    }
  }

  /** A refresh someone asked for (the pane opened, a push, a new branch, the button): no gh cache. */
  function kickFresh(): void {
    lastActivityAt = now()
    wantsFresh = true
    isOffUntilAsked = false
    retryAt = 0
    kick('github')
  }

  async function flush(name: LaneName): Promise<void> {
    const bound = host
    const lane = lanes[name]

    if (bound === null || lane.isRunning) {
      return
    }
    lane.isRunning = true
    lane.isDirty = false
    try {
      await REFRESH[name](bound)
    } catch (error) {
      bound.log(`lanes: the ${name} lane failed: ${String(error)}`)
    } finally {
      lane.isRunning = false
      if (lane.isDirty) {
        kick(name)
      }
    }
  }

  /** stdout of a git command run in `cwd`, or null when it failed, timed out or git is missing. */
  async function git(bound: Host, cwd: string, args: readonly string[]): Promise<string | null> {
    try {
      const ran = await bound.run(['git', '--no-optional-locks', ...args], { cwd, timeoutMs: GIT_TIMEOUT_MS })

      return ran.exitCode === 0 ? ran.stdout : null
    } catch {
      return null
    }
  }

  /** The branch's base: the ref that worked last time in this tree is tried first, so a refresh runs one merge-base. */
  async function mergeBase(bound: Host, cwd: string, top: string): Promise<string | null> {
    const known = baseRefs.get(top)

    for (const ref of known === undefined ? BASE_REFS : [known, ...BASE_REFS.filter(one => one !== known)]) {
      const sha = (await git(bound, cwd, ['merge-base', ref, 'HEAD']))?.trim() ?? ''

      if (sha !== '') {
        baseRefs.set(top, ref)

        return sha
      }
    }
    baseRefs.delete(top)

    return null
  }

  /**
   * Where the branch lives on GitHub: its remote and its name there (its
   * upstream's, else the local one). A detached HEAD has no branch: origin,
   * so the repository's lists can still be read.
   */
  async function remoteOf(bound: Host, top: string, branch: string | null): Promise<{ remote: Remote | null; head: string }> {
    const remoteName =
      (branch === null ? null : (await git(bound, top, ['config', '--get', `branch.${branch}.remote`]))?.trim()) || 'origin'
    const merge = branch === null ? '' : ((await git(bound, top, ['config', '--get', `branch.${branch}.merge`]))?.trim() ?? '')
    const url = (await git(bound, top, ['remote', 'get-url', remoteName]))?.trim() ?? null
    const head = merge.startsWith('refs/heads/') ? merge.slice('refs/heads/'.length) : (branch ?? '')

    return { remote: parseRemote(url), head }
  }

  async function refreshGit(bound: Host): Promise<void> {
    const cwd = await bound.cwd()
    const found = await git(bound, cwd, ['rev-parse', '--show-toplevel', '--show-prefix', '--git-dir'])
    const [top = '', prefix = '', gitDir = ''] = (found ?? '').split(/\r?\n/)

    lastCwd = cwd
    if (found === null || top.trim() === '') {
      repo = null
      subjects = ''
      where = changed(where, { label: baseName(cwd), worktree: null, git: null })
      github = changed(github, null)

      return
    }

    const root = top.trim()
    const statusOut = await git(bound, cwd, ['status', '--porcelain=v2', '--branch', '-uno'])

    // A status that failed or timed out (a lock, a huge tree) says nothing: keep what is shown.
    if (statusOut === null) {
      return
    }

    const status = parseStatus(statusOut)
    const base = status.isUnborn ? null : await mergeBase(bound, cwd, root)
    const diff = status.isUnborn ? null : await git(bound, cwd, ['diff', '--numstat', base ?? 'HEAD'])
    const { added, removed } = parseNumstat(diff ?? '')
    const isDetached = status.branch.startsWith('HEAD ')
    const isNew = repo === null || repo.top !== root || repo.branch !== status.branch
    const place =
      isNew || isRemoteStale || repo === null
        ? await remoteOf(bound, root, isDetached ? null : status.branch)
        : { remote: repo.remote, head: repo.head }

    isRemoteStale = false

    where = changed(where, {
      ...placeOf(root, prefix, gitDir.trim()),
      git: { branch: status.branch, ahead: status.ahead, behind: status.behind, added, removed, changed: status.changed },
    })
    if (options.hasWork) {
      const log = base === null ? null : await git(bound, root, ['log', '--no-merges', `--max-count=${MAX_SUBJECTS}`, '--format=%s', `${base}..HEAD`])

      if ((log ?? '') !== subjects) {
        subjects = log ?? ''
        // New commits may name new tickets: worth a call, through gh's cache.
        kick('github')
      }
    }
    const here: Repo = { top: root, branch: status.branch, isDetached, head: place.head, remote: place.remote }

    // The same place keeps the same object: a GitHub call in flight then knows its answer still holds.
    if (repo === null || !isSamePlace(repo, here)) {
      repo = here
      if (isNew) {
        github = changed(github, null)
      }
      kickFresh()
    }
  }

  async function refreshUsage(bound: Host): Promise<void> {
    const [now, figures, model] = await Promise.all([bound.now(), bound.usage(), bound.model()])

    if (isBudgetStale || model !== budgetModel) {
      isBudgetStale = false
      budgetModel = model
      budget = await bound.usage({ breakdown: 'summary' }).then(
        full => full.context.breakdown?.rawMaxTokens ?? null,
        () => null,
      )
    }
    usage = changed(usage, usageOf(figures, model, budget, now))
  }

  /** Whether anyone can see GitHub's answer now: the status line's PR and CI where it draws, or the open Work pane. */
  function isGithubWanted(): boolean {
    return (options.hasPr && isLineSeen) || (options.hasWork && isWorkOpen)
  }

  async function refreshGithub(bound: Host): Promise<void> {
    const target = repo
    const at = await syncClock(bound)

    if (target === null) {
      problem = changed(problem, null)

      return
    }
    if (isQuiet) {
      canRetry = false
      problem = changed(problem, 'GitHub is off here: CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is set')

      return
    }
    if (!hasGh) {
      return
    }
    if (target.remote === null || !isGithub(target.remote)) {
      canRetry = false
      problem = changed(problem, 'this repository is not on GitHub')
      github = changed(github, null)

      return
    }
    if (!isGithubWanted() || isOffUntilAsked) {
      return
    }

    const isFresh = wantsFresh

    calls = calls.filter(call => at - call < 3_600_000)
    if (calls.length >= MAX_CALLS_PER_HOUR || (!isFresh && at < retryAt)) {
      return
    }
    if (isFresh && at - lastFreshAt < FRESH_GAP_MS) {
      // Too soon after the last fresh call: come back when the gap has passed.
      bound.after(FRESH_GAP_MS - (at - lastFreshAt), () => kick('github'))

      return
    }
    wantsFresh = false

    const defaultBranch = github?.defaultBranch ?? ''
    const input: QueryInput = {
      remote: target.remote,
      head: target.head,
      hasHead: !target.isDetached && target.head !== '' && target.branch !== defaultBranch,
      lists: options.hasWork && isWorkOpen,
      refs: ticketNumbersOf(target.isDetached ? '' : target.branch, subjects, []),
      cacheSeconds: isFresh ? null : isGoing(github, target.branch === defaultBranch) ? BUSY_CACHE_S : CACHE_S,
    }

    calls.push(at)
    lastCallAt = at
    if (isFresh) {
      lastFreshAt = at
    }

    let answer: ReturnType<typeof parseAnswer>

    try {
      const ran = await bound.run(ghArgv(input), { cwd: target.top, timeoutMs: GH_TIMEOUT_MS, env: GH_ENV })

      answer = parseAnswer(ran.stdout, ran.exitCode, ran.stderr, input)
    } catch (error) {
      if (isMissing(error)) {
        // Not asked again until the refresh button: installing gh is the person's.
        hasGh = false
        canRetry = true
        problem = changed(problem, 'gh is not installed: the GitHub parts need the GitHub CLI')
        github = changed(github, null)

        return
      }
      answer = { kind: 'trouble', reason: 'GitHub is not reachable', retryAtMs: null }
    }
    // The branch moved while gh ran: the git lane has asked again.
    if (repo !== target) {
      return
    }
    canRetry = answer.kind !== 'ok'
    if (answer.kind === 'ok') {
      failures = 0
      retryAt = 0
      fetchedAt = now()
      problem = changed(problem, null)
      // A closed pane's lists are not asked for: keep the last ones rather than blank them.
      github = changed(
        github,
        input.lists || github === null ? answer.data : { ...answer.data, board: github.board, reviewQueue: github.reviewQueue, assigned: github.assigned, totals: github.totals },
      )
      show()
    } else if (answer.kind === 'off') {
      // Only the person can fix it: nothing more until they open the pane or press refresh.
      isOffUntilAsked = true
      problem = changed(problem, answer.reason)
      github = changed(github, null)
    } else {
      // Transient: the last answer stays drawn; ask again later, sooner when GitHub said when.
      retryAt = answer.retryAtMs ?? at + (BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)] ?? 1_800_000)
      failures += 1
      problem = changed(problem, answer.reason)
    }
  }

  async function refreshWeekly(bound: Host): Promise<void> {
    if (!options.hasWeekly || !hasPython) {
      weekly = changed(weekly, null)

      return
    }
    // Only the status line shows the totals: no scan for a session that draws it nowhere.
    if (!isLineSeen) {
      return
    }
    try {
      const ran = await bound.run(
        ['python3', '-I', `${bound.root}/scripts/statusline-weekly.py`, '--max-age', String(WEEKLY_MAX_AGE_S)],
        { timeoutMs: WEEKLY_TIMEOUT_MS },
      )

      // A non-zero exit is another session scanning before any total exists: keep what is shown.
      if (ran.exitCode === 0) {
        weekly = changed(weekly, weeklyOf(ran.stdout))
      }
    } catch (error) {
      if (isMissing(error)) {
        hasPython = false
        weekly = changed(weekly, null)
      }
    }
  }

  const REFRESH: Record<LaneName, (bound: Host) => Promise<void>> = {
    git: refreshGit,
    usage: refreshUsage,
    github: refreshGithub,
    weekly: refreshWeekly,
  }

  async function startup(bound: Host): Promise<void> {
    const [nerd, quiet] = await Promise.all([bound.nerdFont(), bound.quietNetwork()])

    // Any value turns it on, `0` included, as Claude Code's own PR badge reads it.
    isQuiet = quiet !== undefined && quiet !== ''
    hasNerdFont = changed(hasNerdFont, nerd !== undefined && /^(1|true|yes|on)$/i.test(nerd.trim()))

    // The notice is about two status lines: with ours off there is only the old one.
    if (!options.hasStatusLine) {
      return
    }

    const command = legacyCommandOf((await bound.settings()).statusLine)

    if (command === null || (await bound.storeGet(LEGACY_KEY)) === command) {
      return
    }
    await bound.storeSet(LEGACY_KEY, command)
    bound.toast(LEGACY_NOTICE, 20_000)
  }

  function onTick(): void {
    const bound = host

    if (bound !== null) {
      void syncClock(bound).then(() => tickOver(bound), () => tickOver(bound))
    }
  }

  function tickOver(bound: Host): void {
    const slower = now() - lastActivityAt > IDLE_MS ? IDLE_FACTOR : 1

    ticks += 1
    if (ticks % (GIT_TICKS * slower) === 0) {
      kick('git')
      kick('usage')
    }
    if (ticks % (WEEKLY_TICKS * slower) === 0) {
      kick('weekly')
    }

    const isOnDefault = repo !== null && github !== null && repo.branch === github.defaultBranch
    const every = (isGoing(github, isOnDefault) ? GITHUB_BUSY_MS : GITHUB_EVERY_MS) * slower

    if (isGithubWanted() && now() - lastCallAt >= every) {
      kick('github')
    }
    // A shell `cd` typed in bash mode (`!cd`) raises no tool call: the directory is polled instead.
    void bound.cwd().then(
      cwd => {
        if (cwd !== lastCwd) {
          kick('git')
        }
      },
      () => undefined,
    )
  }

  function updateSession(change: Partial<StatusSession>): void {
    session = changed(session, { ...session, ...change })
  }

  /** The CI the status line shows: the branch's, or the default branch's when on it. */
  function ciNow(): CiRun | null {
    if (github === null) {
      return null
    }

    return github.ci ?? (repo !== null && repo.branch === github.defaultBranch ? github.defaultCi : null)
  }

  return {
    /** Binds the engine and starts the lanes; a second call (an attached client) changes nothing. */
    start(bound: Host): void {
      if (tick !== null) {
        return
      }
      host = bound
      lastActivityAt = now()
      tick = bound.every(TICK_MS, onTick)
      void startup(bound).catch(error => bound.log(`lanes: startup: ${String(error)}`))
      kickAll()
    },

    /**
     * A surface that draws the status line attached: its pull request, CI and
     * weekly totals are asked for from now on. Before `start`, the first runs ask.
     */
    lineSeen(): void {
      if (isLineSeen) {
        return
      }
      isLineSeen = true
      kick('github')
      kick('weekly')
    },

    /** Now, as epoch ms on the engine's clock: what every drawing and the session log count from. */
    now,

    /** The status line's rows now; empty until the first lane has measured something. */
    rows(nowMs: number): Row[] {
      if (!options.hasStatusLine) {
        return []
      }

      const pr = options.hasPr ? (github?.pr ?? null) : null
      const statusPr: StatusPr | null = pr === null ? null : { number: pr.number, review: pr.review }
      const ci = options.hasPr ? ciNow() : null

      return rowsOf({
        where,
        pr: statusPr,
        usage,
        session,
        weekly,
        hasNerdFont,
        ci: ci === null ? null : { outcome: ci.outcome, isRunning: ci.isRunning, workflow: ci.workflow, at: ci.at },
        compact,
        nowMs,
      })
    },

    /** The Work pane's data; null until the git lane has looked at the directory. */
    work(): Work | null {
      if (where === null) {
        return null
      }

      const remote = repo?.remote ?? null

      return {
        repo: github?.repo ?? (remote === null ? null : `${remote.owner}/${remote.name}`),
        branch: repo?.branch ?? null,
        tickets: github?.tickets ?? [],
        pr: github?.pr ?? null,
        ci: ciNow(),
        board: github?.board ?? null,
        unstarted: github?.assigned ?? null,
        reviewQueue: github?.reviewQueue ?? null,
        totals: github?.totals ?? null,
        fetchedAt,
        problem: repo === null ? 'not a git repository' : problem,
        canRetry: repo !== null && problem !== null && canRetry,
      }
    },

    /** Whether a clock is running in the drawings: a CI run, or the compact button waiting. */
    isBusy(): boolean {
      return ciNow()?.isRunning === true || compact !== 'idle'
    },

    /** The Work pane opened or closed: its lists are asked for only while it is shown. */
    workShown(isShown: boolean): void {
      isWorkOpen = isShown
      if (isShown) {
        kickFresh()
      }
    },

    /** The refresh button, and /workbench refresh: also retries a gh that was missing (it may be installed now). */
    refreshGithub(): void {
      hasGh = true
      kickFresh()
    },

    /** ⟲ compact: the first press arms it for a few seconds, the second runs /compact. */
    pressCompact(): void {
      const bound = host

      if (bound === null || compact === 'running') {
        return
      }
      lastActivityAt = now()
      compactTimer?.cancel()
      if (compact === 'idle') {
        compact = 'armed'
        compactTimer = bound.after(COMPACT_CONFIRM_MS, () => {
          if (compact === 'armed') {
            compact = 'idle'
            show()
          }
        })
      } else {
        compact = 'running'
        // A compaction that never reports back (a reload mid-run) frees the button.
        compactTimer = bound.after(COMPACT_MAX_MS, () => {
          compact = 'idle'
          show()
        })
        // /compact settles once it ran, compacted or not ("not enough messages", Esc, a hook's skip):
        // a compaction has reported back by then, so the button is free either way.
        void bound.runCommand('compact').then(
          () => {
            if (compact === 'running') {
              compactTimer?.cancel()
              compact = 'idle'
              show()
            }
          },
          error => {
            compactTimer?.cancel()
            compact = 'idle'
            bound.toast(`Could not compact: ${String(error).slice(0, 120)}`)
            show()
          },
        )
      }
      show()
    },

    /** A compaction finished (classic PostCompact). */
    compacted(): void {
      compactTimer?.cancel()
      compact = 'idle'
      isBudgetStale = true
      kick('usage')
      show()
    },

    /** classic SessionStart: `clear` and `resume` begin another conversation, `compact` moved the context. */
    sessionStarted(source: string, agentType: string | undefined, isMainThread: boolean): void {
      lastActivityAt = now()
      if (isMainThread) {
        updateSession(
          source === 'clear' || source === 'resume'
            ? { ...NO_SESSION, effort: session.effort, agent: agentType ?? null }
            : { agent: agentType ?? null },
        )
      }
      if (source !== 'startup') {
        kick('git')
        kick('usage')
        kick('weekly')
      }
    },

    /** The effort the main loop runs at, from turn.step or classic Stop. */
    effortSeen(effort: string | number | undefined): void {
      if (effort !== undefined) {
        updateSession({ effort: String(effort) })
      }
    },

    /** classic Stop: the --agent name. */
    turnStopped(agentType: string | undefined, isMainThread: boolean): void {
      if (isMainThread && agentType !== undefined) {
        updateSession({ agent: agentType })
      }
    },

    turnCompleted(usageOfTurn: TurnUsage | undefined, isMainThread: boolean): void {
      lastActivityAt = now()
      if (isMainThread && usageOfTurn !== undefined) {
        updateSession({
          cacheRead: session.cacheRead + count(usageOfTurn.cache_read_input_tokens),
          cacheWrite: session.cacheWrite + count(usageOfTurn.cache_creation_input_tokens),
          uncached: session.uncached + count(usageOfTurn.input_tokens),
        })
      }
      kick('git')
      if (isMainThread) {
        kick('usage')
      }
    },

    /** A tool that can write ran: git may have moved; a push or a PR command changes what GitHub says. */
    toolRan(isWrite: boolean, result: unknown): void {
      const operation = gitOperationOf(result)

      lastActivityAt = now()
      if (isWrite) {
        kick('git')
      }
      if (operation.isPush) {
        // `git push -u` sets an upstream: the branch's name on the remote may be new.
        isRemoteStale = true
        kick('git')
      }
      if (operation.isPush || operation.isPr) {
        kickFresh()
      }
    },

    /** A prompt sent while idle: the person may have changed things outside the session. */
    promptSent(): void {
      lastActivityAt = now()
      kick('git')
    },

    /** The model, its window or the compaction window may have changed. */
    windowChanged(): void {
      isBudgetStale = true
      kick('usage')
    },

    measured(): void {
      kick('usage')
    },
  }
}

export type Lanes = ReturnType<typeof createLanes>
