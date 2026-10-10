import { describe, expect, test } from 'claude-code/testing'
import type { ProcessRunInit, ProcessRunResult, SessionUsage } from 'claude-code'

import type { Host } from '../hooks/host'
import { createLanes, type Lanes, type LaneOptions } from '../hooks/lanes'

// The refresh lanes (hooks/lanes.ts) behind the status line and the Work pane,
// driven by a hand-written Host on a virtual clock: the tests move time with
// `advance`, answer git and gh from here, and read the rules for how often
// GitHub is asked off the calls gh received. Time is virtual, so every run
// repeats; a rule is read in a window of seconds around its edge, not on the
// edge itself, because a tick comes every five seconds and a kick waits 1.5 s.

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const BRANCH = 'feat/12-cache-widgets'
const SHA = 'abcdef0123456789abcdef0123456789abcdef01'

const gitFor = (branch: string): Record<string, string> => ({
  'rev-parse --show-toplevel --show-prefix --git-dir': '/repo\n\n/repo/.git\n',
  'status --porcelain=v2 --branch -uno': [
    '# branch.oid 0123456789abcdef0123456789abcdef01234567',
    `# branch.head ${branch}`,
    `# branch.upstream origin/${branch}`,
    '# branch.ab +0 -0',
    '',
  ].join('\n'),
  'merge-base origin/HEAD HEAD': 'feedbeef\n',
  'diff --numstat feedbeef': '',
  [`config --get branch.${branch}.remote`]: 'origin\n',
  [`config --get branch.${branch}.merge`]: `refs/heads/${branch}\n`,
  'remote get-url origin': 'git@github.com:acme/widgets.git\n',
  'log --no-merges --max-count=50 --format=%s feedbeef..HEAD': 'Cache the widgets\n',
})

/** What gh printed for one call. */
type Printed = { exitCode: number; stdout: string; stderr: string }

/** One gh call as the lanes made it, and when (ms on the virtual clock). */
type Call = { at: number; argv: readonly string[]; init: ProcessRunInit | undefined }

const OFFLINE: Printed = { exitCode: 1, stdout: '', stderr: 'error connecting to api.github.com\n' }
const NOT_LOGGED_IN: Printed = { exitCode: 4, stdout: '', stderr: 'To get started with GitHub CLI, please run:  gh auth login\n' }

const checkRun = (isPending: boolean) => ({
  __typename: 'CheckRun',
  name: 'build',
  status: isPending ? 'IN_PROGRESS' : 'COMPLETED',
  conclusion: isPending ? null : 'SUCCESS',
  startedAt: '2026-10-07T11:50:00Z',
  completedAt: isPending ? null : '2026-10-07T11:55:00Z',
  detailsUrl: 'https://github.com/acme/widgets/actions/runs/1',
})
const rollup = (isPending: boolean) => ({
  state: isPending ? 'PENDING' : 'SUCCESS',
  contexts: { totalCount: 1, nodes: [checkRun(isPending)] },
})

/**
 * What gh answers when it works: the branch's pull request, its CI and the
 * default branch's CI, each with its checks going or done as asked.
 */
function answered({ prPending = false, ciPending = false, defaultPending = false } = {}): Printed {
  const pr = {
    number: 42,
    title: 'Cache the widgets',
    url: 'https://github.com/acme/widgets/pull/42',
    state: 'OPEN',
    isDraft: false,
    reviewDecision: 'APPROVED',
    author: { login: 'octocat' },
    headRefName: BRANCH,
    updatedAt: '2026-10-07T11:00:00Z',
    isCrossRepository: false,
    baseRefName: 'main',
    mergeStateStatus: 'CLEAN',
    statusCheckRollup: rollup(prPending),
  }

  return {
    exitCode: 0,
    stderr: '',
    stdout: JSON.stringify({
      data: {
        viewer: { login: 'octocat' },
        rateLimit: { cost: 1, remaining: 4990, resetAt: '2026-10-07T13:00:00Z' },
        repository: {
          nameWithOwner: 'acme/widgets',
          defaultBranchRef: { name: 'main', target: { oid: SHA, statusCheckRollup: rollup(defaultPending) } },
          branch: { target: { oid: SHA, statusCheckRollup: rollup(ciPending) } },
          head: { nodes: [pr] },
        },
      },
    }),
  }
}

/**
 * A Host whose time only moves when `advance` says. `gh` answers each call by
 * its number (1 for the first), at once or after a wait on the virtual clock.
 */
function hostOf(gh: (call: Call, nth: number) => Printed | Promise<Printed>, git: Record<string, string> = gitFor(BRANCH)) {
  const start = Date.now()
  const timers = new Map<number, { due: number; fn: () => void; period: number | null }>()
  const calls: Call[] = []
  let t = 0
  let ids = 0

  function schedule(ms: number, fn: () => void, period: number | null) {
    const id = (ids += 1)

    timers.set(id, { due: t + ms, fn, period })

    return { cancel: () => void timers.delete(id) }
  }

  /** Lets every promise chain the last step started run as far as it can. */
  async function settle(): Promise<void> {
    for (let turn = 0; turn < 400; turn += 1) {
      await Promise.resolve()
    }
  }

  const done = (stdout: string): ProcessRunResult => ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

  const host: Host = {
    root: '/plugin',
    now: async () => start + t,
    after: (ms, fn) => schedule(ms, fn, null),
    every: (ms, fn) => schedule(ms, fn, ms),
    cwd: async () => '/repo',
    model: async () => 'claude-opus-5-5',
    usage: async () => ({ startedAt: 0, context: { tokens: 1_000, window: 200_000, percent: 1 }, rateLimits: [] }) as SessionUsage,
    run: async (argv, init) => {
      const [command = '', ...rest] = argv

      if (command === 'git') {
        const line = rest.filter(arg => arg !== '--no-optional-locks').join(' ')

        return line in git ? done(git[line] ?? '') : { ...done(''), exitCode: 128, stderr: 'fatal\n' }
      }
      if (command !== 'gh') {
        throw new Error(`unexpected command: ${argv.join(' ')}`)
      }

      const call: Call = { at: t, argv, init }

      calls.push(call)

      return { ...(await gh(call, calls.length)), isStdoutTruncated: false, isStderrTruncated: false }
    },
    nerdFont: async () => undefined,
    quietNetwork: async () => undefined,
    settings: async () => ({}),
    storeGet: async () => undefined,
    storeSet: async () => undefined,
    invalidate: () => undefined,
    toast: () => undefined,
    log: () => undefined,
    openPane: async () => ({ isPlaced: true }),
    closePane: async () => undefined,
    panes: async () => [],
    registerCommand: async () => ({}),
    runCommand: async () => ({}),
    copy: async () => ({}),
  }

  /** Moves the clock on, running each timer when it falls due and letting what it started finish before the next. */
  async function advance(ms: number): Promise<void> {
    const end = t + ms

    await settle()
    for (;;) {
      const due = [...timers].filter(([, timer]) => timer.due <= end).sort(([, a], [, b]) => a.due - b.due)[0]

      if (due === undefined) {
        break
      }

      const [id, timer] = due

      t = Math.max(t, timer.due)
      if (timer.period === null) {
        timers.delete(id)
      } else {
        timer.due += timer.period
      }
      timer.fn()
      await settle()
    }
    t = end
    await settle()
  }

  return { host, advance, calls, now: () => t }
}

type World = ReturnType<typeof hostOf>

/** The lanes started on a fresh host, as a terminal starts them (it draws the status line); `options` says what is drawn. */
function started(gh: Parameters<typeof hostOf>[0], options: Partial<LaneOptions> = {}, git?: Record<string, string>) {
  const world = hostOf(gh, git)
  const lanes = createLanes({ hasStatusLine: true, hasWeekly: false, hasPr: true, hasWork: true, ...options })

  lanes.lineSeen()
  lanes.start(world.host)

  return { ...world, lanes }
}

/**
 * Moves the clock on while the person keeps working: a tool call every
 * minute, so that the session never counts as idle. The time is `ms` from now.
 */
async function working(world: World & { lanes: Lanes }, ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= MINUTE) {
    world.lanes.toolRan(false, undefined)
    await world.advance(Math.min(left, MINUTE))
  }
}

/** How much later each call came than the one before. */
const gapsOf = (calls: readonly Call[]) => calls.slice(1).map((call, index) => call.at - (calls[index]?.at ?? 0))

/** The `--cache` a call asked gh for, or null for a fresh call. */
const cacheOf = (call: Call): string | null => {
  const at = call.argv.indexOf('--cache')

  return at < 0 ? null : (call.argv[at + 1] ?? null)
}

describe('GitHub call budget', () => {
  test('an answer only the person can fix (not logged in) latches: no more calls on the timer until a refresh', async () => {
    let isLoggedIn = false
    const world = started(() => (isLoggedIn ? answered() : NOT_LOGGED_IN))
    const { lanes, calls, advance } = world

    await advance(10 * SECOND)
    expect(calls.length).toBe(1)
    expect(lanes.work()?.problem).toBe('gh is not logged in: run gh auth login')
    expect(lanes.work()?.canRetry).toBe(true)
    // Half an hour, with the person at work: the timer asks nothing.
    await working(world, 30 * MINUTE)
    expect(calls.length).toBe(1)

    // The refresh button asks once, and an answer that is still "off" latches again.
    lanes.refreshGithub()
    await advance(5 * SECOND)
    expect(calls.length).toBe(2)
    expect(cacheOf(calls[1] as Call)).toBeNull()
    await working(world, 30 * MINUTE)
    expect(calls.length).toBe(2)

    // Logged in at last: the next refresh reads GitHub, and the timer is back.
    isLoggedIn = true
    lanes.refreshGithub()
    await advance(5 * SECOND)
    expect(calls.length).toBe(3)
    expect(lanes.work()?.problem).toBeNull()
    expect(lanes.work()?.pr?.number).toBe(42)
    await working(world, 3 * MINUTE)
    expect(calls.length).toBe(4)
  })

  test('a transient failure backs the timer off 2, 4, 8, 16, then 30 minutes: no call before the retry time, one after', async () => {
    const world = started(() => OFFLINE)
    const { lanes, calls, advance } = world

    await advance(10 * SECOND)
    expect(calls.length).toBe(1)
    expect(lanes.work()?.problem).toBe('GitHub is not reachable')
    for (const [index, wait] of [2, 4, 8, 16, 30, 30].entries()) {
      const retryAt = (calls.at(-1) as Call).at + wait * MINUTE

      await working(world, retryAt - 10 * SECOND - world.now())
      expect(calls.length, `${wait} minutes after call ${index + 1}, 10 s before the retry time`).toBe(index + 1)
      await working(world, 20 * SECOND)
      expect(calls.length, `${wait} minutes after call ${index + 1}, 10 s after the retry time`).toBe(index + 2)
    }
    expect(gapsOf(calls).map(gap => Math.round(gap / MINUTE))).toEqual([2, 4, 8, 16, 30, 30])
  })

  test('an answer that comes through starts the backoff over: the next failure waits two minutes again', async () => {
    // Three failures (2, 4, then 8 minutes), the fourth call answers, and the fifth fails again.
    const world = started((call, nth) => (nth === 4 ? answered() : OFFLINE))
    const { calls } = world

    await working(world, 20 * MINUTE)
    expect(gapsOf(calls).map(gap => Math.round(gap / MINUTE))).toEqual([2, 4, 8, 2, 2])
  })

  test('the hard cap: 120 calls in a rolling hour, however often the person asks', async () => {
    const world = started(() => answered())
    const { lanes, calls, advance } = world

    // A refresh every 16 s, just past the 15 s between fresh calls: 225 an hour asked for.
    for (let at = 10 * SECOND; at < 3590 * SECOND; at += 16 * SECOND) {
      await advance(at - world.now())
      lanes.refreshGithub()
    }
    await advance(10 * SECOND)
    expect(calls.length).toBe(120)
    // The 120th came well inside the hour, and nothing after it until the first one is an hour old.
    expect((calls.at(-1) as Call).at).toBeLessThan(40 * MINUTE)

    // Past the hour the first calls age out of the window, and asking works again.
    for (let at = 3600 * SECOND; at < 3700 * SECOND; at += 16 * SECOND) {
      await advance(at - world.now())
      lanes.refreshGithub()
    }
    await advance(10 * SECOND)
    expect(calls.length).toBeGreaterThan(120)
    for (const call of calls) {
      const inHour = calls.filter(other => other.at >= call.at && other.at < call.at + HOUR)

      expect(inHour.length, `calls in the hour from ${call.at / SECOND} s`).toBeLessThanOrEqual(120)
    }
  })

  test("the timer's own calls count toward the cap too", async () => {
    // A check is pending, so the timer asks every minute for half an hour; then the person asks every 16 s on top.
    const world = started(() => answered({ prPending: true }))
    const { lanes, calls, advance } = world

    await working(world, 30 * MINUTE)
    expect(calls.length).toBeGreaterThanOrEqual(25)
    for (let at = world.now() + 16 * SECOND; at < 59 * MINUTE; at += 16 * SECOND) {
      await advance(at - world.now())
      lanes.refreshGithub()
    }
    await advance(10 * SECOND)
    // 28 timer calls and 108 asks inside the first hour: the timer's calls and the person's share the 120.
    expect(calls.length).toBe(120)
  })

  test('a second fresh call inside the 15 s since the last one waits for the gap, then runs once', async () => {
    const world = started(() => answered())
    const { lanes, calls, advance } = world

    await advance(10 * SECOND)
    expect(calls.length).toBe(1)
    expect(cacheOf(calls[0] as Call)).toBeNull()

    // 8.5 s after the last fresh call, asked for twice.
    lanes.refreshGithub()
    lanes.refreshGithub()
    await advance(5 * SECOND)
    expect(calls.length).toBe(1)
    await advance(5 * SECOND)
    expect(calls.length).toBe(2)
    expect((calls[1] as Call).at - (calls[0] as Call).at).toBeGreaterThanOrEqual(15 * SECOND)
    expect(cacheOf(calls[1] as Call)).toBeNull()
    // Once, not once for each ask; and the timer's own cadence goes on from there.
    await advance(60 * SECOND)
    expect(calls.length).toBe(2)

    // Past the gap, a fresh call goes out at once.
    const pressedAt = world.now()

    lanes.refreshGithub()
    await advance(5 * SECOND)
    expect(calls.length).toBe(3)
    expect((calls[2] as Call).at - pressedAt).toBeLessThan(5 * SECOND)
  })

  describe('the timer asks every minute while a check is going, and every two minutes otherwise', () => {
    const cases = [
      { name: 'a check of the pull request is pending', printed: answered({ prPending: true }), branch: BRANCH },
      { name: "the branch's CI run is in progress", printed: answered({ ciPending: true }), branch: BRANCH },
      { name: "the default branch's CI run is in progress and the session is on it", printed: answered({ defaultPending: true }), branch: 'main' },
    ]

    for (const { name, printed, branch } of cases) {
      test(`${name}: calls come about a minute apart, asking gh to cache for 55 s`, async () => {
        const world = started(() => printed, {}, gitFor(branch))

        await working(world, 6 * MINUTE)
        expect(world.calls.length).toBeGreaterThanOrEqual(5)
        for (const gap of gapsOf(world.calls)) {
          expect(gap).toBeGreaterThanOrEqual(MINUTE)
          expect(gap).toBeLessThan(MINUTE + 10 * SECOND)
        }
        expect(world.calls.slice(1).map(cacheOf)).toEqual(world.calls.slice(1).map(() => '55s'))
      })
    }

    test('nothing is going: calls come two minutes apart, asking gh to cache for 110 s', async () => {
      const world = started(() => answered())

      await working(world, 8 * MINUTE)
      expect(world.calls.length).toBeGreaterThanOrEqual(4)
      for (const gap of gapsOf(world.calls)) {
        expect(gap).toBeGreaterThanOrEqual(2 * MINUTE)
        expect(gap).toBeLessThan(2 * MINUTE + 10 * SECOND)
      }
      expect(world.calls.slice(1).map(cacheOf)).toEqual(world.calls.slice(1).map(() => '110s'))
    })

    test("the default branch's run going does not hurry the timer when the session is on another branch", async () => {
      const world = started(() => answered({ defaultPending: true }))

      await working(world, 8 * MINUTE)
      for (const gap of gapsOf(world.calls)) {
        expect(gap).toBeGreaterThanOrEqual(2 * MINUTE)
      }
    })

    test('the cadence follows the latest answer: a minute while a check is pending, two once it is done', async () => {
      const world = started((call, nth) => answered({ prPending: nth <= 3 }))

      await working(world, 12 * MINUTE)

      const gaps = gapsOf(world.calls)

      expect(gaps.length).toBeGreaterThanOrEqual(5)
      for (const gap of gaps.slice(0, 3)) {
        expect(gap).toBeGreaterThanOrEqual(MINUTE)
        expect(gap).toBeLessThan(MINUTE + 10 * SECOND)
      }
      for (const gap of gaps.slice(3)) {
        expect(gap).toBeGreaterThanOrEqual(2 * MINUTE)
        expect(gap).toBeLessThan(2 * MINUTE + 10 * SECOND)
      }
    })
  })

  test('an idle session (nothing for ten minutes) asks every ten minutes, and any activity brings back the two', async () => {
    const world = started(() => answered())
    const { lanes, calls, advance } = world

    // The first ten minutes still count as active, whatever the person does: a call about every two.
    await advance(10 * MINUTE)
    expect(calls.length).toBe(5)

    // Then idle: from the next call on, ten minutes apart.
    await advance(3400 * SECOND - world.now())
    expect(calls.length).toBeGreaterThanOrEqual(8)
    expect(calls.length).toBeLessThanOrEqual(10)
    for (const gap of gapsOf(calls.filter(call => call.at > 8 * MINUTE))) {
      expect(gap).toBeGreaterThanOrEqual(10 * MINUTE)
      expect(gap).toBeLessThan(10 * MINUTE + 15 * SECOND)
    }

    // The person comes back: the very next tick asks, and the two minutes are back.
    const idleCalls = calls.length

    lanes.toolRan(false, undefined)
    await advance(10 * SECOND)
    expect(calls.length).toBe(idleCalls + 1)
    await working(world, 6 * MINUTE)
    expect(calls.length).toBeGreaterThanOrEqual(idleCalls + 3)
    for (const gap of gapsOf(calls.slice(idleCalls))) {
      expect(gap).toBeGreaterThanOrEqual(2 * MINUTE)
      expect(gap).toBeLessThan(2 * MINUTE + 10 * SECOND)
    }
  })

  test('with no PR switch on the status line and the Work pane closed, GitHub is not asked at all; the pane being placed asks, closing it stops again', async () => {
    const world = started(() => answered(), { hasPr: false })
    const { lanes, calls, advance } = world

    await working(world, 30 * MINUTE)
    expect(calls).toEqual([])
    // The git lane did look at the directory: only GitHub was left alone.
    expect(lanes.work()?.branch).toBe(BRANCH)

    lanes.workShown(true)
    await advance(5 * SECOND)
    expect(calls.length).toBe(1)
    expect(calls[0]?.argv).toContain('lists=true')
    await working(world, 5 * MINUTE)
    expect(calls.length).toBeGreaterThanOrEqual(3)

    lanes.workShown(false)

    const open = calls.length

    await working(world, 30 * MINUTE)
    expect(calls.length).toBe(open)
  })

  test('started for a surface that draws no status line (an editor), GitHub is asked only for the Work pane, until one that draws it attaches', async () => {
    const lanes = createLanes({ hasStatusLine: true, hasWeekly: false, hasPr: true, hasWork: true })
    const world = { ...hostOf(() => answered()), lanes }
    const { calls, advance } = world

    lanes.start(world.host)
    await working(world, 30 * MINUTE)
    expect(calls).toEqual([])
    expect(lanes.work()?.branch).toBe(BRANCH)

    // The Work pane is placed there: its lists are asked for, and nothing once it closes.
    lanes.workShown(true)
    await advance(5 * SECOND)
    expect(calls.length).toBe(1)
    expect(calls[0]?.argv).toContain('lists=true')
    lanes.workShown(false)
    await working(world, 30 * MINUTE)
    expect(calls.length).toBe(1)

    // The terminal or the desktop app attaches: the pull request and the CI are asked for at once, then on the timer.
    lanes.lineSeen()
    await advance(5 * SECOND)
    expect(calls.length).toBe(2)
    await working(world, 5 * MINUTE)
    expect(calls.length).toBeGreaterThanOrEqual(4)

    // A second surface that draws it changes nothing.
    const before = calls.length

    lanes.lineSeen()
    await advance(5 * SECOND)
    expect(calls.length).toBe(before)
  })
})
