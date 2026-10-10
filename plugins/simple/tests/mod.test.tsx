import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { CommandSpec, On, ProcessRunInit, RenderSurface, SessionContextBreakdown, SessionUsage } from 'claude-code'

import { GH_ENV } from '../hooks/github'

// The whole mod through the engine's test kit. Nothing answers beneath the
// plugin in a test: this file stands in for the engine, the git repository,
// GitHub's gh and python3. Every call the module makes on `$` is answered
// here, or the hook that made it is skipped. The commands are checked as they
// are made: git, gh and python3 each have to be run the way the module means
// to run them, in every test, not only in the one that looks.

/** The plugin's folder as `claude plugin test` loaded it: this file is in its tests/. */
const ROOT = (import.meta as unknown as { dir: string }).dir.replace(/\/tests$/, '')
const SURFACES = ['terminal', 'desktop'] as const
const NOW = Date.parse('2026-10-07T12:00:00Z')
const START = { cwd: '/repo', surface: 'terminal', isInteractive: true } as const
const FULLSCREEN = { columns: 160, rows: 45, isFullscreen: true } as const
const MAIN_SCREEN = { columns: 160, rows: 45, isFullscreen: false } as const
const AUTO = { options: { workbenchAutoOpen: true } } as const
const USAGE_LINE = 'Usage: /workbench [work|session] [open|close|refresh]'
/** Why the fake surface leaves a pane waiting, as its `ui.open` says it. */
const WAITS = 'the terminal is 100 columns wide; 144 are needed'
const HINT = { component: 'PromptHint', props: { isDraft: false, isWorking: false, hint: '? for shortcuts' } } as const
const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 115, scroll: { offset: 0, bodyRows: 9 }, view: {} },
} as const
const paneOf = (id: 'simple-work' | 'simple-session') =>
  ({
    component: 'Pane',
    requestId: id,
    props: {
      title: id === 'simple-work' ? 'Work' : 'Session',
      isFocused: false,
      bodyColumns: 72,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 60 },
      view: {},
    },
  }) as const

const BRANCH = 'feat/12-cache-widgets'
const OTHER = 'feat/13-tidy-widgets'
/** A branch whose upstream was deleted on GitHub (a merged pull request): the remote has no such ref. */
const GONE = 'feat/14-merged-and-deleted'

/** What git answers in a repository on `branch`, which has an upstream of the same name. */
const gitFor = (branch: string): Record<string, string> => ({
  'rev-parse --show-toplevel --show-prefix --git-dir': '/repo\npkg/sub/\n/repo/.git\n',
  'status --porcelain=v2 --branch -uno': [
    '# branch.oid 0123456789abcdef0123456789abcdef01234567',
    `# branch.head ${branch}`,
    `# branch.upstream origin/${branch}`,
    '# branch.ab +2 -1',
    '1 .M N... 100644 100644 100644 aaa bbb src/a.ts',
    '1 M. N... 100644 100644 100644 ccc ddd src/b.ts',
    '',
  ].join('\n'),
  'merge-base origin/HEAD HEAD': 'feedbeef\n',
  'diff --numstat feedbeef': '3\t1\tsrc/a.ts\n-\t-\tlogo.png\n4\t0\tsrc/b.ts\n',
  [`config --get branch.${branch}.remote`]: 'origin\n',
  [`config --get branch.${branch}.merge`]: `refs/heads/${branch}\n`,
  'remote get-url origin': 'git@github.com:acme/widgets.git\n',
  'log --no-merges --max-count=50 --format=%s feedbeef..HEAD': 'Cache the widgets\nRefs #45 while here\n',
})
const GIT = gitFor(BRANCH)

const run = (name: string, conclusion: string | null, status = 'COMPLETED') => ({
  __typename: 'CheckRun',
  name,
  status,
  conclusion,
  startedAt: '2026-10-07T11:50:00Z',
  completedAt: status === 'COMPLETED' ? '2026-10-07T11:55:00Z' : null,
  detailsUrl: `https://github.com/acme/widgets/actions/runs/1/job/${name}`,
})
const CHECKS = { state: 'FAILURE', contexts: { totalCount: 2, nodes: [run('build', 'SUCCESS'), run('lint', 'FAILURE')] } }
const PASSING = { state: 'SUCCESS', contexts: { totalCount: 1, nodes: [run('build', 'SUCCESS')] } }
const SHA = 'abcdef0123456789abcdef0123456789abcdef01'

type Ask = {
  /** Whether the branch's own pull request and CI are asked for (not on the default branch, not detached). */
  hasHead?: boolean
  /** The branch asked about: BRANCH has pull request 42 and a failing check, OTHER pull request 43, 'main' none, GONE has no ref on GitHub. */
  head?: string
}

/** gh api graphql's answer, shaped as GitHub returns the module's query. */
function graphql(lists: boolean, { hasHead = true, head = BRANCH }: Ask = {}): string {
  const pr = {
    number: 42,
    title: 'Cache the widgets',
    url: 'https://github.com/acme/widgets/pull/42',
    state: 'OPEN',
    isDraft: false,
    reviewDecision: 'APPROVED',
    author: { login: 'octocat' },
    repository: { name: 'widgets', nameWithOwner: 'acme/widgets' },
    headRefName: BRANCH,
    updatedAt: '2026-10-07T11:00:00Z',
    isCrossRepository: false,
    baseRefName: 'main',
    mergeStateStatus: 'BLOCKED',
    autoMergeRequest: null,
    reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'User', login: 'alice' } }] },
    latestReviews: { nodes: [{ state: 'APPROVED', author: { login: 'bob' } }] },
    closingIssuesReferences: {
      nodes: [
        {
          number: 12,
          title: 'Cache the widgets',
          state: 'OPEN',
          url: 'https://github.com/acme/widgets/issues/12',
          repository: { name: 'widgets', nameWithOwner: 'acme/widgets' },
        },
      ],
    },
    statusCheckRollup: CHECKS,
  }
  const row = (number: number, title: string, author: string) => ({
    number,
    title,
    url: `https://github.com/acme/widgets/pull/${number}`,
    state: 'OPEN',
    isDraft: false,
    reviewDecision: 'REVIEW_REQUIRED',
    author: { login: author },
    repository: { name: 'widgets', nameWithOwner: 'acme/widgets' },
    headRefName: `feat/${number}-x`,
    updatedAt: '2026-10-07T09:00:00Z',
    closingIssuesReferences: { nodes: [] },
  })
  const own =
    head === BRANCH
      ? pr
      : head === OTHER
        ? { ...pr, number: 43, title: 'Tidy the widgets', url: 'https://github.com/acme/widgets/pull/43', headRefName: OTHER, statusCheckRollup: PASSING, closingIssuesReferences: { nodes: [] } }
        : null
  const repository = {
    nameWithOwner: 'acme/widgets',
    defaultBranchRef: { name: 'main', target: { oid: SHA, statusCheckRollup: PASSING } },
    ...(hasHead
      ? {
          branch: head === GONE ? null : { target: { oid: SHA, statusCheckRollup: head === BRANCH ? CHECKS : PASSING } },
          head: { nodes: own === null ? [] : [own] },
        }
      : {}),
    r45: { __typename: 'Issue', number: 45, title: 'Fix the crash', state: 'OPEN', url: 'https://github.com/acme/widgets/issues/45' },
    ...(lists ? { team: { totalCount: 2, nodes: [pr, row(40, 'Bump the toolchain', 'bob')] } } : {}),
  }

  return JSON.stringify({
    data: {
      viewer: { login: 'octocat' },
      rateLimit: { cost: 1, remaining: 4990, resetAt: '2026-10-07T13:00:00Z' },
      repository,
      ...(lists
        ? {
            review: { issueCount: 1, nodes: [row(51, 'Speed up the parser', 'alice')] },
            assigned: {
              issueCount: 1,
              nodes: [
                {
                  number: 7,
                  title: 'Document the cache',
                  url: 'https://github.com/acme/widgets/issues/7',
                  state: 'OPEN',
                  updatedAt: '2026-10-06T09:00:00Z',
                  repository: { name: 'widgets', nameWithOwner: 'acme/widgets' },
                  closedByPullRequestsReferences: { nodes: [] },
                },
              ],
            },
          }
        : {}),
    },
  })
}

const USAGE: SessionUsage = {
  startedAt: NOW - 60_000,
  context: { tokens: 95_000, window: 1_000_000, percent: 10 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 2, resetsAt: '2026-10-07T15:00:00Z' },
    { kind: 'seven_day', percentUsed: 49, resetsAt: '2026-10-10T16:00:00Z' },
  ],
  cost: { usd: 2.2259 },
}

const WEEKLY = JSON.stringify({
  updated: 1,
  since: '2026-09-30T12',
  by_model: { 'claude-opus-5-5': 6_500_000_000, 'claude-sonnet-5-5': 8_200_000_000, 'claude-haiku-4-5-20251001': 34_000_000 },
})

type World = {
  git: Record<string, string>
  /** false: gh is not installed. */
  hasGh: boolean
  env: Record<string, string>
  /** What the plugin's store holds when the session starts. */
  store: Record<string, unknown>
  /** How long gh takes to answer, on the mocked clock. */
  ghMs: number
  /** How long an MCP tool takes to answer, on the mocked clock. */
  mcpMs: number
  /** The panes the surface leaves waiting for room: their `ui.open` answers `isPlaced: false`. */
  waits: Set<string>
  /** Another plugin holds /workbench: `command.register` refuses the name. */
  isNameTaken: boolean
  /** The surface refuses to open a pane: `ui.open` is denied. */
  refusesOpen: boolean
  /** What the session draws on, as `session.surfaces` lists it. */
  surfaces: readonly RenderSurface[]
}

const WORLD: World = {
  git: GIT,
  hasGh: true,
  env: {},
  store: {},
  ghMs: 0,
  mcpMs: 0,
  waits: new Set(),
  isNameTaken: false,
  refusesOpen: false,
  surfaces: ['terminal'],
}

/** A command the module ran through `$.process.run`, as it asked for it. */
type Ran = { argv: readonly string[]; init: ProcessRunInit }
/** A question put to GitHub, read off the arguments of the gh call. */
type Asked = { head: string; hasHead: boolean; lists: boolean; isCached: boolean }
/** A pane as the fake surface holds it. */
type PaneState = { isPlaced: boolean; isShown: boolean }

/** The value of a `-f name=value` or `-F name=value` of a gh call. */
const fieldOf = (argv: readonly string[], name: string) => argv.find(arg => arg.startsWith(`${name}=`))?.slice(name.length + 1) ?? ''

/**
 * Answers every call the module makes and records what it ran. The world it
 * answers from is a copy: a test changes it (the branch git is on, a pane that
 * waits) through the `world` it gets back.
 */
function engine(on: On, given: World = WORLD) {
  const world: World = { ...given, git: { ...given.git }, store: { ...given.store }, waits: new Set(given.waits) }
  const runs: string[] = []
  const ran: Ran[] = []
  const gh: { isCached: boolean; lists: boolean }[] = []
  const asked: Asked[] = []
  const commands: string[] = []
  const registered: string[] = []
  const specs: CommandSpec[] = []
  const opened: string[] = []
  const opens: { id: string; isRaised: boolean }[] = []
  const closed: string[] = []
  /** The panes the fake surface holds, in the order they were opened. */
  const panes = new Map<string, PaneState>()
  const store = new Map<string, unknown>(Object.entries(world.store))
  const stored: [string, unknown][] = []
  /** The `tool_use_id` of each tool call that reached the bottom, in order. */
  const ids: string[] = []
  const clock = mock.clock(on, { now: NOW })

  mock.env(on, world.env)
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    stored.push([e.key, e.value])
    store.set(e.key, e.value)

    return { value: undefined }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.attach', ($, e) => ({ clientId: e.clientId }))
  on('session.surfaces', () => ({ value: world.surfaces }))
  on('session.cwd', () => ({ value: '/repo/pkg/sub' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', ($, e) => {
    if (e.breakdown === undefined) {
      return { value: USAGE }
    }

    const breakdown = { rawMaxTokens: 300_000 } as unknown as SessionContextBreakdown

    return { value: { ...USAGE, context: { ...USAGE.context, breakdown } } }
  })
  on('settings.read', () => ({ value: {} }))
  on('process.run', async ($, e) => {
    const [command = '', ...rest] = e.argv
    const init = e.init ?? {}
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    const failed = { value: { exitCode: 128, stdout: '', stderr: 'fatal\n', isStdoutTruncated: false, isStderrTruncated: false } }

    ran.push({ argv: e.argv, init })
    if (command === 'git') {
      // A status must not take the locks the person's own git needs; nothing may hang; the directory is the session's or its repository's.
      expect(rest[0], `git ${rest.join(' ')}: --no-optional-locks comes first`).toBe('--no-optional-locks')
      expect(init.timeoutMs, `git ${rest.join(' ')}: a timeout`).toBeGreaterThan(0)
      expect(init.cwd, `git ${rest.join(' ')}: a directory in the repository`).toMatch(/^\/repo(\/|$)/)

      const line = rest.slice(1).join(' ')

      runs.push(`git ${line}`)

      return line in world.git ? ok(world.git[line] ?? '') : failed
    }
    if (command === 'gh') {
      const lists = rest.includes('lists=true')
      const head = fieldOf(rest, 'head')
      const hasHead = rest.includes('hasHead=true')

      // Recorded before it is refused: a gh that is not there was still asked.
      runs.push('gh api graphql')
      gh.push({ isCached: rest.includes('--cache'), lists })
      asked.push({ head, hasHead, lists, isCached: rest.includes('--cache') })
      // Pinned to github.com whatever GH_HOST says, quiet and parseable, at the repository's top, and not left hanging.
      expect(rest.slice(0, 4), 'gh api graphql --hostname github.com').toEqual(['api', 'graphql', '--hostname', 'github.com'])
      expect(init.env, 'gh runs with its quiet environment').toEqual(GH_ENV)
      expect(init.env?.CLICOLOR_FORCE, 'gh: no forced colour').toBe('0')
      expect(init.env?.GH_PROMPT_DISABLED, 'gh: no prompt').toBe('1')
      expect(init.cwd, "gh runs at the repository's top, not in the folder the session is in").toBe('/repo')
      expect(init.timeoutMs, 'gh: a timeout').toBeGreaterThan(0)
      if (!world.hasGh) {
        return { deny: 'failed to start: ENOENT: Executable not found in $PATH' }
      }
      if (world.ghMs > 0) {
        await clock.sleep(world.ghMs)
      }

      return ok(graphql(lists, { hasHead, head }))
    }
    if (command === 'python3') {
      // Isolated mode, the plugin's own script, and a two-minute cache so that sessions do not scan the transcripts in turn.
      expect(e.argv, 'python3 runs the weekly script').toEqual(['python3', '-I', `${ROOT}/scripts/statusline-weekly.py`, '--max-age', '120'])
      expect(init.timeoutMs, 'python3: a timeout').toBeGreaterThan(0)
      runs.push('python3')

      return ok(WEEKLY)
    }

    return { deny: `unexpected command: ${e.argv.join(' ')}` }
  })
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.copy', () => ({ value: { isCopied: true } }))
  on('ui.open', ($, e) => {
    if (world.refusesOpen) {
      return { deny: 'no room for a pane' }
    }

    const before = panes.get(e.id)
    const isPlaced = !world.waits.has(e.id)
    const isRaised = e.focus === true

    opened.push(e.id)
    opens.push({ id: e.id, isRaised })
    if (isRaised && isPlaced) {
      // A pane raised is the one shown; the others are tabs behind it.
      for (const state of panes.values()) {
        state.isShown = false
      }
    }
    panes.set(e.id, { isPlaced, isShown: isPlaced && (isRaised || before === undefined || before.isShown) })

    return { value: isPlaced ? { isPlaced: true as const } : { isPlaced: false as const, reason: WAITS } }
  })
  on('ui.close', ($, e) => {
    closed.push(e.id)
    panes.delete(e.id)

    return { value: undefined }
  })
  on('ui.panes', () => ({
    value: [...panes].map(([id, state]) => ({ id, title: id, isShown: state.isShown, isFocused: false, isPlaced: state.isPlaced })),
  }))
  on('command.register', ($, e) => {
    // Recorded before it is refused: a name another plugin holds was still asked for.
    registered.push(e.name)
    if (world.isNameTaken) {
      return { deny: `the name ${e.name} is taken by another plugin` }
    }
    specs.push({ ...e })

    return { value: { command: e.name } }
  })
  on('command.run', ($, e) => {
    commands.push(e.command)

    return {}
  })
  on('tool.check', () => ({ decision: 'allow' }))
  on('tool.call', async ($, e) => {
    ids.push(e.tool_use_id ?? '')
    if (String(e.tool).startsWith('mcp__')) {
      if (world.mcpMs > 0) {
        await clock.sleep(world.mcpMs)
      }

      return { result: { ok: true } }
    }
    if (e.tool === 'Bash') {
      return { result: { stdout: '', stderr: '', interrupted: false, gitOperation: { push: { branch: BRANCH } } } }
    }

    return { result: { ok: true } }
  })
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'agent-1' }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('classic.SessionStart', () => ({}))
  on('classic.Stop', () => ({}))
  on('classic.PostCompact', () => ({}))
  on('classic.PostToolUse', () => ({}))
  on('classic.PostToolUseFailure', () => ({}))
  on('ui.render', { component: 'PromptHint' }, ($, e) => {
    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box key="engine">
        <Text dimColor>{e.props.hint}</Text>
      </Box>
    )
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)

    return <Box key="band" />
  })

  return { runs, ran, gh, asked, commands, registered, specs, opened, opens, closed, panes, store, stored, ids, world, clock }
}

type Found = { text: string; props: Readonly<Record<string, unknown>> }
type Drawing = {
  find: (query: { key?: string; type?: 'Text' | 'Box' | 'Button'; text?: string | RegExp }) => Promise<Found | undefined>
  findAll: (query: { type: 'Text' }) => Promise<readonly Found[]>
}

/** The status line's rows as drawn: each row is a keyed Box. */
async function rowsOf(ui: Drawing): Promise<string[]> {
  const rows: string[] = []

  for (const key of ['status-row-1', 'status-row-2']) {
    const row = await ui.find({ key })

    if (row !== undefined) {
      rows.push(row.text)
    }
  }

  return rows
}

/** Every line of text a pane drew. */
async function linesOf(ui: Drawing): Promise<string[]> {
  return (await ui.findAll({ type: 'Text' })).filter(found => found.props.wrap !== undefined).map(found => found.text)
}

async function started($: { session: { start: (input: typeof START) => Promise<unknown> } }, clock: { advance: (ms: number) => Promise<void>; settle: () => Promise<void> }) {
  await $.session.start(START)
  await clock.advance(5_000)
  await clock.settle()
}

/** The person types /workbench with `args`. */
const workbench = ($: Engine, args: string) => $.command.run({ command: 'workbench', args } as never)

/** One model request of a turn, read to its end. */
async function step($: Engine, input: Partial<Parameters<Engine['turn']['step']>[0]> = {}) {
  const stream = $.turn.step({ turnId: 'turn-1', index: 0, model: 'claude-opus-5-5', messageCount: 1, ...input })

  for await (const chunk of stream) {
    void chunk
  }

  return stream.result
}

const ROW_1 = `repo/pkg/sub │ ${BRANCH} ↑2↓1 +7/-1 ✱2 │ PR #42 ✓ │ CI ✗ lint`
const ROW_2 =
  'Opus 5.5 1M │ ctx ▰▰▰▱▱▱▱▱▱▱ 32% 95k/300k ⟲ compact │ $2.23 │ 5h ▰▱▱▱▱ 2% · 7d ▰▰▱▱▱ 49% ↻3d4h │ 7d Sonnet 8.2B Opus 6.5B Haiku 34M'

describe('status line', () => {
  test('draws both rows under the engine hint, on terminal and desktop', async ($, on) => {
    const { clock } = engine(on)

    await started($, clock)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'simple', surface, ...HINT })

      expect(await ui.find({ key: 'engine' })).toBeDefined()
      expect(await rowsOf(ui)).toEqual([ROW_1, ROW_2])
      await ui.unmount()
    }
  })

  test('⟲ compact asks for a second press, then runs /compact until the compaction reports back', async ($, on) => {
    const { clock, commands } = engine(on)

    await started($, clock)

    const ui = await $.ui.mount({ plugin: 'simple', surface: 'terminal', ...HINT })

    await ui.press({ key: 'compact' })
    expect((await ui.find({ key: 'compact' }))?.text).toBe('⟲ confirm')
    expect(commands).toEqual([])
    await ui.press({ key: 'compact' })
    expect(commands).toEqual(['compact'])
    // /compact settled (compacted or not): the button is back.
    expect((await ui.find({ key: 'compact' }))?.text).toBe('⟲ compact')
  })

  test('⟲ compact is no button while /compact runs, and comes back when it settles without compacting', async ($, on) => {
    let release = (): void => undefined
    const settled = new Promise<void>(resolve => {
      release = resolve
    })

    // Registered before the engine's own command.run fake, so it answers /compact: slowly, compacting nothing.
    on('command.run', { command: 'compact' }, async () => {
      await settled

      return { text: 'Not enough messages to compact.' }
    })

    const { clock } = engine(on)

    await started($, clock)

    const ui = await $.ui.mount({ plugin: 'simple', surface: 'terminal', ...HINT })

    await ui.press({ key: 'compact' })
    void ui.press({ key: 'compact' })
    await clock.advance(100)
    expect(await ui.find({ key: 'compact' })).toBeUndefined()
    expect((await rowsOf(ui))[1]).toContain('⟲ compacting…')
    release()
    await clock.settle()
    expect((await ui.find({ key: 'compact' }))?.text).toBe('⟲ compact')
  })

  test('an armed ⟲ compact goes back by itself when the second press does not come', async ($, on) => {
    const { clock, commands } = engine(on)

    await started($, clock)

    const ui = await $.ui.mount({ plugin: 'simple', surface: 'terminal', ...HINT })

    await ui.press({ key: 'compact' })
    await clock.advance(6_000)
    await clock.settle()
    expect((await ui.find({ key: 'compact' }))?.text).toBe('⟲ compact')
    expect(commands).toEqual([])
  })

  test('draws in the band above the prompt when asked to', { options: { statuslineAbovePrompt: true } }, async ($, on) => {
    const { clock } = engine(on)

    await started($, clock)
    for (const surface of SURFACES) {
      const hint = await $.ui.mount({ plugin: 'simple', surface, ...HINT })

      expect(await rowsOf(hint)).toEqual([])
      await hint.unmount()

      const band = await $.ui.mount({ plugin: 'simple', surface, ...BAND })

      expect(await rowsOf(band)).toEqual([ROW_1, ROW_2])
      expect(await band.find({ key: 'band' })).toBeDefined()
      await band.redraw({ ...BAND.props, hasSurvey: true })
      expect(await rowsOf(band)).toEqual([])
      await band.unmount()
    }
  })

  test('yields the band to a survey, and draws the rows again once it is gone', { options: { statuslineAbovePrompt: true } }, async ($, on) => {
    const { clock } = engine(on)

    await started($, clock)
    for (const surface of SURFACES) {
      const band = await $.ui.mount({ plugin: 'simple', surface, ...BAND })

      expect(await rowsOf(band)).toEqual([ROW_1, ROW_2])
      // A survey is on screen: only what is beneath is drawn, the engine's own band, none of the rows.
      await band.redraw({ ...BAND.props, hasSurvey: true })
      expect(await band.find({ key: 'band' })).toBeDefined()
      expect(await rowsOf(band)).toEqual([])
      // And it is gone: the rows are back above the band.
      await band.redraw({ ...BAND.props, hasSurvey: false })
      expect(await rowsOf(band)).toEqual([ROW_1, ROW_2])
      expect(await band.find({ key: 'band' })).toBeDefined()
      await band.unmount()
    }
  })

  test('draws the effort of the main loop after the model, from a model request and from a Stop', async ($, on) => {
    const { clock } = engine(on)

    await started($, clock)

    const ui = await $.ui.mount({ plugin: 'simple', surface: 'terminal', ...HINT })

    // None known yet: the model alone.
    expect((await rowsOf(ui))[1]).toStartWith('Opus 5.5 1M │ ctx')
    await step($, { effort: 'high' })
    expect((await rowsOf(ui))[1]).toStartWith('Opus 5.5 1M ▮▮▮▯▯ high │ ctx')
    await $.classic.Stop({ stop_hook_active: false, effort: { level: 'max' } })
    expect((await rowsOf(ui))[1]).toStartWith('Opus 5.5 1M ▮▮▮▮▮ max │ ctx')
  })

  test("leaves the effort alone when it is a subagent's request or Stop", async ($, on) => {
    const { clock } = engine(on)

    await started($, clock)

    const ui = await $.ui.mount({ plugin: 'simple', surface: 'terminal', ...HINT })

    await step($, { effort: 'high' })
    await step($, { effort: 'low', agentId: 'agent-1' })
    await $.classic.Stop({ stop_hook_active: false, agent_id: 'agent-1', agent_type: 'Explore', effort: { level: 'low' } })
    expect((await rowsOf(ui))[1]).toStartWith('Opus 5.5 1M ▮▮▮▯▯ high │ ctx')
  })

  test("on the default branch, the CI segment is the default branch's run", async ($, on) => {
    const { clock, asked } = engine(on, { ...WORLD, git: gitFor('main') })

    await started($, clock)

    const ui = await $.ui.mount({ plugin: 'simple', surface: 'terminal', ...HINT })

    expect((await rowsOf(ui))[0]).toMatch(/^repo\/pkg\/sub │ main ↑2↓1 \+7\/-1 ✱2 │ CI ✓ \d+m$/)
    // Once GitHub has said which branch is the default, the branch's own run is no longer asked for: the default's is the one shown.
    await clock.advance(130_000)
    await clock.settle()
    expect(asked.map(call => call.hasHead)).toEqual([true, false])
    expect((await rowsOf(ui))[0]).toMatch(/^repo\/pkg\/sub │ main ↑2↓1 \+7\/-1 ✱2 │ CI ✓ \d+m$/)
  })

  test("on another branch with no CI of its own, there is no CI segment, not the default branch's", async ($, on) => {
    const { clock, asked } = engine(on, { ...WORLD, git: gitFor(GONE) })

    await started($, clock)

    const ui = await $.ui.mount({ plugin: 'simple', surface: 'terminal', ...HINT })

    expect(asked[0]).toMatchObject({ head: GONE, hasHead: true })
    expect((await rowsOf(ui))[0]).toBe(`repo/pkg/sub │ ${GONE} ↑2↓1 +7/-1 ✱2`)
  })

  test('runs nothing at all with the status line and the side panes off', { options: { statusline: false, workbench: false } }, async ($, on) => {
    const { clock, runs } = engine(on)

    await started($, clock)

    const ui = await $.ui.mount({ plugin: 'simple', surface: 'terminal', ...HINT })

    expect(await rowsOf(ui)).toEqual([])
    expect(runs).toEqual([])
  })
})

describe('GitHub', () => {
  test('one fresh call at the start, then gh-cached calls every two minutes, without the lists while the pane is closed', async ($, on) => {
    const { clock, gh } = engine(on)

    await started($, clock)
    expect(gh).toEqual([{ isCached: false, lists: false }])
    await clock.advance(130_000)
    await clock.settle()
    expect(gh.length).toBe(2)
    expect(gh[1]).toEqual({ isCached: true, lists: false })
  })

  test('/workbench work opens the pane and asks GitHub afresh with the lists', async ($, on) => {
    const { clock, gh, opened } = engine(on)

    await started($, clock)
    await clock.advance(20_000)
    await $.command.run({ command: 'workbench', args: 'work' } as never)
    await clock.advance(5_000)
    await clock.settle()
    expect(opened).toEqual(['simple-work'])
    expect(gh.at(-1)).toEqual({ isCached: false, lists: true })
  })

  test('a push in the session asks GitHub afresh', async ($, on) => {
    const { clock, gh } = engine(on)

    await started($, clock)
    await clock.advance(20_000)
    await $.tool.call({ tool: 'Bash', command: 'git push' })
    await clock.advance(5_000)
    await clock.settle()
    expect(gh.length).toBe(2)
    expect(gh[1]?.isCached).toBe(false)
  })

  test('a remote that is not on GitHub asks gh nothing, and the Work pane says why', async ($, on) => {
    const { clock, runs } = engine(on, { ...WORLD, git: { ...GIT, 'remote get-url origin': 'git@gitlab.example.com:acme/widgets.git\n' } })

    await started($, clock)
    await $.command.run({ command: 'workbench', args: 'work' } as never)
    await clock.advance(5_000)
    await clock.settle()
    expect(runs).not.toContain('gh api graphql')

    const ui = await $.ui.mount({ plugin: 'simple', surface: 'terminal', ...paneOf('simple-work') })

    expect((await linesOf(ui)).join('\n')).toMatch(/not on GitHub/)
  })

  test('without gh, it is tried once, the Work pane says so, and nothing tries again until the person asks to refresh', async ($, on) => {
    const { clock, runs } = engine(on, { ...WORLD, hasGh: false })
    const attempts = () => runs.filter(line => line === 'gh api graphql').length

    await started($, clock)
    expect(attempts()).toBe(1)
    await clock.advance(300_000)
    await clock.settle()
    expect(attempts()).toBe(1)

    const hint = await $.ui.mount({ plugin: 'simple', surface: 'terminal', ...HINT })

    expect((await rowsOf(hint))[0]).toBe(`repo/pkg/sub │ ${BRANCH} ↑2↓1 +7/-1 ✱2`)

    const pane = await $.ui.mount({ plugin: 'simple', surface: 'terminal', ...paneOf('simple-work') })

    expect((await linesOf(pane)).join('\n')).toMatch(/gh is not installed/)
    expect((await linesOf(pane)).join('\n')).toMatch(/press ↻ to read GitHub again/)

    // Installed since, perhaps: a refresh tries once more, and a gh that is still missing is not tried again.
    expect(await workbench($, 'refresh')).toEqual({})
    await clock.advance(5_000)
    await clock.settle()
    expect(attempts()).toBe(2)
    await clock.advance(300_000)
    await clock.settle()
    expect(attempts()).toBe(2)
  })

  test('with gh back, a refresh reads GitHub and the pull request is drawn', async ($, on) => {
    const { clock, runs, world } = engine(on, { ...WORLD, hasGh: false })

    await started($, clock)
    world.hasGh = true
    await workbench($, 'refresh')
    // The 15 s between fresh calls count from the first, which was refused.
    await clock.advance(20_000)
    await clock.settle()
    expect(runs.filter(line => line === 'gh api graphql').length).toBe(2)

    const hint = await $.ui.mount({ plugin: 'simple', surface: 'terminal', ...HINT })

    expect((await rowsOf(hint))[0]).toBe(ROW_1)
  })

  test('asks git, gh and python3 with the arguments each is meant to have', async ($, on) => {
    const { clock, ran } = engine(on)

    await started($, clock)

    const gits = ran.filter(call => call.argv[0] === 'git')
    const ghs = ran.filter(call => call.argv[0] === 'gh')
    const pythons = ran.filter(call => call.argv[0] === 'python3')

    // git: never a lock the person's own git might need, never left hanging, and the first look is from the folder the session is in.
    expect(gits.length).toBeGreaterThan(5)
    for (const { argv, init } of gits) {
      expect(argv.slice(0, 2), argv.join(' ')).toEqual(['git', '--no-optional-locks'])
      expect(init.timeoutMs, argv.join(' ')).toBeGreaterThan(0)
    }
    expect(gits[0]?.argv).toEqual(['git', '--no-optional-locks', 'rev-parse', '--show-toplevel', '--show-prefix', '--git-dir'])
    expect(gits[0]?.init.cwd).toBe('/repo/pkg/sub')

    // python3: isolated, the plugin's own script, and the two-minute cache.
    expect(pythons.map(call => call.argv)).toEqual([['python3', '-I', `${ROOT}/scripts/statusline-weekly.py`, '--max-age', '120']])
    expect(pythons[0]?.init.timeoutMs).toBeGreaterThan(0)

    // gh: on github.com whatever GH_HOST says, quiet, at the repository's top, and not left hanging.
    expect(ghs.length).toBe(1)
    expect(ghs[0]?.argv.slice(0, 5)).toEqual(['gh', 'api', 'graphql', '--hostname', 'github.com'])
    expect(ghs[0]?.init.env).toEqual(GH_ENV)
    expect(ghs[0]?.init.env?.CLICOLOR_FORCE).toBe('0')
    expect(ghs[0]?.init.env?.GH_PROMPT_DISABLED).toBe('1')
    expect(ghs[0]?.init.cwd).toBe('/repo')
    expect(ghs[0]?.init.timeoutMs).toBeGreaterThan(0)
  })

  test('a git refresh on the same branch while gh is in flight does not drop its answer', async ($, on) => {
    const { clock, asked } = engine(on, { ...WORLD, ghMs: 3_000 })

    await $.session.start(START)

    const ui = await $.ui.mount({ plugin: 'simple', surface: 'terminal', ...HINT })

    // gh was asked at about 1.5 s and answers at 4.5 s. An edit lands in between: git is read again at 2 s.
    await clock.advance(1_600)
    expect(asked.length).toBe(1)
    await $.tool.call({ tool: 'Edit', file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' } as never)
    await clock.advance(1_000)
    expect((await rowsOf(ui))[0]).not.toContain('PR #')

    // The answer comes: the branch is the same, and the pull request is drawn at once, not at the next call two minutes on.
    await clock.advance(2_000)
    await clock.settle()
    expect(asked.length).toBe(1)
    expect((await rowsOf(ui))[0]).toBe(ROW_1)
  })

  test('a branch change while gh is in flight drops its answer, and asks again, fresh', async ($, on) => {
    const { clock, asked, world } = engine(on, { ...WORLD, ghMs: 3_000 })

    await $.session.start(START)

    const ui = await $.ui.mount({ plugin: 'simple', surface: 'terminal', ...HINT })

    await clock.advance(1_600)
    expect(asked).toEqual([{ head: BRANCH, hasHead: true, lists: false, isCached: false }])

    // The session moves to another branch while gh is thinking about the first one.
    world.git = gitFor(OTHER)
    await $.tool.call({ tool: 'Edit', file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' } as never)
    await clock.advance(1_000)
    expect((await rowsOf(ui))[0]).toStartWith(`repo/pkg/sub │ ${OTHER} `)

    // gh answers for the branch it was asked about: that is not this one, and none of it is drawn.
    await clock.advance(2_000)
    await clock.settle()
    expect((await rowsOf(ui))[0]).not.toContain('PR #')
    expect((await rowsOf(ui))[0]).not.toContain('CI')

    // The question is asked again, for this branch and fresh, as soon as the 15 s since the last fresh call allow.
    await clock.advance(15_000)
    await clock.settle()
    expect(asked).toEqual([
      { head: BRANCH, hasHead: true, lists: false, isCached: false },
      { head: OTHER, hasHead: true, lists: false, isCached: false },
    ])
    await clock.advance(3_000)
    await clock.settle()
    expect((await rowsOf(ui))[0]).toBe(`repo/pkg/sub │ ${OTHER} ↑2↓1 +7/-1 ✱2 │ PR #43 ✓ │ CI ✓ 5m`)
  })

  test("a branch change clears the pull request of the branch left at once, and draws the new one's when GitHub answers", async ($, on) => {
    const { clock, world } = engine(on)

    await started($, clock)

    const ui = await $.ui.mount({ plugin: 'simple', surface: 'terminal', ...HINT })

    expect((await rowsOf(ui))[0]).toBe(ROW_1)
    world.git = gitFor(OTHER)
    await $.tool.call({ tool: 'Edit', file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' } as never)
    await clock.advance(1_000)
    expect((await rowsOf(ui))[0]).toBe(`repo/pkg/sub │ ${OTHER} ↑2↓1 +7/-1 ✱2`)
    await clock.advance(20_000)
    await clock.settle()
    expect((await rowsOf(ui))[0]).toBe(`repo/pkg/sub │ ${OTHER} ↑2↓1 +7/-1 ✱2 │ PR #43 ✓ │ CI ✓ 5m`)
  })

  test("with the status line's pull request off, GitHub is asked only once the Work pane is open", { options: { statuslinePr: false } }, async ($, on) => {
    const { clock, runs, gh } = engine(on)

    await started($, clock)
    await clock.advance(300_000)
    await clock.settle()
    expect(runs).not.toContain('gh api graphql')

    const hint = await $.ui.mount({ plugin: 'simple', surface: 'terminal', ...HINT })

    expect((await rowsOf(hint))[0]).toBe(`repo/pkg/sub │ ${BRANCH} ↑2↓1 +7/-1 ✱2`)
    await workbench($, 'work')
    await clock.advance(5_000)
    await clock.settle()
    expect(gh).toEqual([{ isCached: false, lists: true }])
  })

  test('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC turns GitHub off, whatever its value', async ($, on) => {
    const { clock, runs } = engine(on, { ...WORLD, env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '0' } })

    await started($, clock)
    await clock.advance(300_000)
    await clock.settle()
    expect(runs).not.toContain('gh api graphql')
  })
})

describe('Work pane', () => {
  test("shows the branch's ticket, its pull request with reviews and the failing check, CI, the board and the queues", async ($, on) => {
    const { clock } = engine(on)

    await started($, clock)
    await clock.advance(20_000)
    await $.command.run({ command: 'workbench', args: 'work' } as never)
    await clock.advance(5_000)
    await clock.settle()
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'simple', surface, ...paneOf('simple-work') })
      const text = (await linesOf(ui)).join('\n')

      expect(text).toMatch(/acme\/widgets · feat\/12-cache-widgets/)
      expect(text).toMatch(/#12 Cache the widgets/)
      expect(text).toMatch(/#45 Fix the crash/)
      expect(text).toMatch(/#42 Cache the widgets/)
      expect(text).toMatch(/alice/)
      expect(text).toMatch(/lint/)
      expect(text).toMatch(/#40 Bump the toolchain/)
      expect(text).toMatch(/#51 Speed up the parser/)
      expect(text).toMatch(/#7 Document the cache · no PR yet/)
      await ui.unmount()
    }
  })
})

describe('Session pane', () => {
  test('counts MCP calls by server, logs edits and follows an agent', async ($, on) => {
    const { clock } = engine(on)

    await started($, clock)
    await $.tool.call({ tool: 'mcp__docs__search', query: 'mods' } as never)
    await $.tool.call({ tool: 'mcp__docs__search', query: 'panes' } as never)
    await $.tool.call({ tool: 'Edit', file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' } as never)
    await $.agent.spawn({ description: 'Map the parser', subagentType: 'general-purpose', prompt: 'x' } as never)

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'simple', surface, ...paneOf('simple-session') })
      const text = (await linesOf(ui)).join('\n')

      expect(text).toMatch(/docs/)
      expect(text).toMatch(/2 calls/)
      expect(text).toMatch(/src\/a\.ts/)
      expect(text).toMatch(/Map the parser/)
      await ui.unmount()
    }
  })
})

describe('MCP timings', () => {
  /** The server's row of the Session pane, drawn again from what the log holds now. */
  const server = async (ui: Drawing & { redraw: () => Promise<void> }) => {
    await ui.redraw()

    return (await ui.findAll({ type: 'Text' })).map(found => found.text).find(line => line.startsWith('docs')) ?? ''
  }

  /**
   * A session whose MCP calls take 5 s on the clock (a permission prompt, say), with the Session pane up. The module
   * follows the engine's clock at each of its 5 s ticks, so a call that starts and ends on a tick is timed at 5 s.
   */
  async function slow($: Engine, on: On) {
    const { clock, ids } = engine(on, { ...WORLD, mcpMs: 5_000 })

    await started($, clock)

    const ui = await $.ui.mount({ plugin: 'simple', surface: 'terminal', ...paneOf('simple-session') })
    const call = async (query: string) => {
      const settled = $.tool.call({ tool: 'mcp__docs__search', query } as never)

      await clock.advance(5_000)
      await settled
    }
    const post = (event: 'PostToolUse' | 'PostToolUseFailure', id: string | undefined, ms?: number) =>
      $.classic[event]({
        tool_name: 'mcp__docs__search',
        tool_input: {},
        tool_use_id: id ?? '',
        ...(ms === undefined ? {} : { duration_ms: ms }),
        ...(event === 'PostToolUse' ? { tool_response: {} } : { error: 'boom' }),
      } as never)

    return { clock, ids, ui, call, post }
  }

  test("are the tool's own duration when PostToolUse reports it after the call settled", async ($, on) => {
    const { ids, ui, call, post } = await slow($, on)

    await call('mods')
    expect(await server(ui)).toBe('docs 1 call · avg 5.0s · max 5.0s · last 0s ago')
    await post('PostToolUse', ids[0], 120)
    expect(await server(ui)).toBe('docs 1 call · avg 120ms · max 120ms · last 0s ago')
  })

  test("are the tool's own duration when PostToolUse reports it while the call is still out", async ($, on) => {
    const { clock, ids, ui, post } = await slow($, on)
    const settled = $.tool.call({ tool: 'mcp__docs__search', query: 'mods' } as never)

    await clock.advance(1_000)
    await post('PostToolUse', ids[0], 80)
    await clock.advance(4_000)
    await settled
    expect(await server(ui)).toBe('docs 1 call · avg 80ms · max 80ms · last 0s ago')
  })

  test("are the tool's own duration when PostToolUseFailure reports it, and each call has its own", async ($, on) => {
    const { ids, ui, call, post } = await slow($, on)

    await call('mods')
    await post('PostToolUse', ids[0], 120)
    await call('panes')
    await post('PostToolUseFailure', ids[1], 40)
    expect(await server(ui)).toMatch(/^docs 2 calls · avg 80ms · max 120ms · /)
  })

  test('are the wall time of the call when PostToolUse reports none', async ($, on) => {
    const { ids, ui, call, post } = await slow($, on)

    await call('mods')
    await post('PostToolUse', ids[0])
    expect(await server(ui)).toBe('docs 1 call · avg 5.0s · max 5.0s · last 0s ago')
  })
})

describe('a new conversation', () => {
  const CACHED = { model: 'claude-opus-5-5', input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 900 }
  const UNCACHED = { ...CACHED, input_tokens: 1_000, cache_read_input_tokens: 0 }

  /** A session that has made two MCP calls and a turn served from the cache (90%), with the status line and the Session pane up. */
  async function held($: Engine, on: On) {
    const { clock } = engine(on)

    await started($, clock)

    const status = await $.ui.mount({ plugin: 'simple', surface: 'terminal', ...HINT })
    const pane = await $.ui.mount({ plugin: 'simple', surface: 'terminal', ...paneOf('simple-session') })
    const row2 = async () => (await rowsOf(status))[1] ?? ''
    const text = async () => (await linesOf(pane)).join('\n')
    const work = async (usage: typeof CACHED) => {
      await $.tool.call({ tool: 'mcp__docs__search', query: 'mods' } as never)
      await $.tool.call({ tool: 'mcp__docs__search', query: 'panes' } as never)
      await $.turn.complete({ turnId: 'turn-1', reason: 'answer', answer: 'Done.', durationMs: 1_200, isAborted: false, usage } as never)
    }

    await step($, { effort: 'high' })
    await work(CACHED)
    expect(await row2()).toContain('cache 90%')
    expect(await text()).toMatch(/docs 2 calls/)

    return { row2, text, work }
  }

  test('a compaction keeps what the Session pane holds and the cache ratio', async ($, on) => {
    const { row2, text } = await held($, on)

    // A compaction shrinks the context, not the session.
    await $.classic.SessionStart({ source: 'compact' })
    expect(await row2()).toContain('cache 90%')
    expect(await text()).toMatch(/docs 2 calls/)
  })

  for (const [source, usage, ratio] of [
    ['clear', UNCACHED, 'cache 0%'],
    ['resume', CACHED, 'cache 90%'],
  ] as const) {
    test(`/${source} empties the Session pane and starts the cache ratio over, and the next conversation counts from there`, async ($, on) => {
      const { row2, text, work } = await held($, on)

      await $.classic.SessionStart({ source })
      expect(await text()).toMatch(/no MCP calls yet/)
      expect(await text()).not.toMatch(/docs/)
      expect(await row2()).not.toContain('cache')
      // The effort is the model's setting, not the conversation's.
      expect(await row2()).toStartWith('Opus 5.5 1M ▮▮▮▯▯ high │ ctx')

      await work(usage)
      expect(await row2()).toContain(ratio)
      expect(await text()).toMatch(/docs 2 calls/)
    })
  }
})

describe('side panes', () => {
  test('open by themselves on a fullscreen terminal when that is turned on', { options: { workbenchAutoOpen: true } }, async ($, on) => {
    const { clock, opened } = engine(on)

    await started($, clock)

    const ui = await $.ui.mount({ plugin: 'simple', surface: 'terminal', ...HINT, viewport: { columns: 160, rows: 45, isFullscreen: true } })

    await clock.advance(1_000)
    await clock.settle()
    expect(opened).toEqual(['simple-work', 'simple-session'])
    await ui.unmount()
  })

  test('never open by themselves when that is off, the default', async ($, on) => {
    const { clock, opened } = engine(on)

    await started($, clock)

    const ui = await $.ui.mount({ plugin: 'simple', surface: 'terminal', ...HINT, viewport: { columns: 160, rows: 45, isFullscreen: true } })

    await clock.advance(1_000)
    await clock.settle()
    expect(opened).toEqual([])
    await ui.unmount()
  })

  test('a bare /workbench opens both, and closes both once they are seen', async ($, on) => {
    const { clock, opened } = engine(on)

    await started($, clock)
    expect(await $.command.run({ command: 'workbench', args: '' } as never)).toEqual({})
    expect(opened).toEqual(['simple-work', 'simple-session'])
    expect(await $.command.run({ command: 'workbench', args: 'nonsense here' } as never)).toEqual({
      text: 'Usage: /workbench [work|session] [open|close|refresh]',
    })
  })
})

describe('/workbench', () => {
  test('a bare one opens both panes; the next closes both and remembers it; the one after opens them again', async ($, on) => {
    const { clock, opens, closed, commands, store, stored } = engine(on)

    await started($, clock)
    expect(await workbench($, '')).toEqual({})
    expect(opens).toEqual([
      { id: 'simple-work', isRaised: false },
      { id: 'simple-session', isRaised: false },
    ])
    expect(store.get('closedPanes')).toEqual([])

    // Both are placed and shown: the command closes them, and the person has closed them as far as the next session is concerned.
    expect(await workbench($, '')).toEqual({})
    expect(closed).toEqual(['simple-work', 'simple-session'])
    expect(store.get('closedPanes')).toEqual(['simple-work', 'simple-session'])

    expect(await workbench($, '')).toEqual({})
    expect(opens.length).toBe(4)
    expect(store.get('closedPanes')).toEqual([])
    expect(stored.length).toBe(4)
    // It is the module's command: it never went down to the engine's.
    expect(commands).toEqual([])
  })

  test('/workbench work toggles only the Work pane', async ($, on) => {
    const { clock, opens, closed, panes, store } = engine(on)

    await started($, clock)
    await workbench($, '')
    expect(await workbench($, 'work')).toEqual({})
    expect(closed).toEqual(['simple-work'])
    expect([...panes.keys()]).toEqual(['simple-session'])
    expect(store.get('closedPanes')).toEqual(['simple-work'])

    // Opened again, it is no longer a pane the person closed.
    expect(await workbench($, 'work')).toEqual({})
    expect(opens.at(-1)).toEqual({ id: 'simple-work', isRaised: false })
    expect([...panes.keys()]).toEqual(['simple-session', 'simple-work'])
    expect(closed).toEqual(['simple-work'])
    expect(store.get('closedPanes')).toEqual([])
  })

  test('a pane that waits for room is opened again, not closed, and the answer says it waits', async ($, on) => {
    const { clock, opens, closed, panes, world } = engine(on, { ...WORLD, waits: new Set(['simple-work']) })

    await started($, clock)
    expect(await workbench($, 'work')).toEqual({ text: `The Work pane waits: ${WAITS}` })
    expect(panes.get('simple-work')).toEqual({ isPlaced: false, isShown: false })

    // It is listed, even as the front tab, but not drawn, so nobody sees it: /workbench opens it again, and closes nothing.
    panes.set('simple-work', { isPlaced: false, isShown: true })
    expect(await workbench($, 'work')).toEqual({ text: `The Work pane waits: ${WAITS}` })
    expect(opens).toEqual([
      { id: 'simple-work', isRaised: false },
      { id: 'simple-work', isRaised: true },
    ])
    expect(closed).toEqual([])

    // The terminal is widened: the next one places it.
    world.waits.delete('simple-work')
    expect(await workbench($, 'work')).toEqual({})
    expect(panes.get('simple-work')).toEqual({ isPlaced: true, isShown: true })
    expect(closed).toEqual([])
  })

  test('a pane behind another tab is raised with focus, not closed', async ($, on) => {
    const { clock, opens, closed, panes } = engine(on)

    await started($, clock)
    await workbench($, '')
    // Work is the tab in front; Session is placed but behind it.
    panes.set('simple-session', { isPlaced: true, isShown: false })
    expect(await workbench($, 'session')).toEqual({})
    expect(opens.at(-1)).toEqual({ id: 'simple-session', isRaised: true })
    expect(closed).toEqual([])
    expect(panes.get('simple-session')).toEqual({ isPlaced: true, isShown: true })
    expect(panes.get('simple-work')).toEqual({ isPlaced: true, isShown: false })
  })

  test('close closes the panes that are open, and remembers those and no other', async ($, on) => {
    const { clock, closed, panes, store } = engine(on)

    await started($, clock)
    await workbench($, 'work')
    expect(await workbench($, 'close')).toEqual({})
    expect(closed).toEqual(['simple-work'])
    expect(panes.size).toBe(0)
    expect(store.get('closedPanes')).toEqual(['simple-work'])
    // And nothing is left to close.
    expect(await workbench($, 'close')).toEqual({})
    expect(closed).toEqual(['simple-work'])
    expect(store.get('closedPanes')).toEqual(['simple-work'])
  })

  test('open opens both whatever is up, and raises none', async ($, on) => {
    const { clock, opens, closed } = engine(on)

    await started($, clock)
    await workbench($, 'session')
    expect(await workbench($, 'open')).toEqual({})
    expect(opens).toEqual([
      { id: 'simple-session', isRaised: false },
      { id: 'simple-work', isRaised: false },
      { id: 'simple-session', isRaised: false },
    ])
    expect(closed).toEqual([])
  })

  test('refresh opens nothing, forgets nothing, and asks GitHub afresh', async ($, on) => {
    const { clock, opens, closed, gh, store, stored } = engine(on, { ...WORLD, store: { closedPanes: ['simple-work'] } })

    await started($, clock)
    await clock.advance(20_000)
    expect(gh).toEqual([{ isCached: false, lists: false }])
    expect(await workbench($, 'refresh')).toEqual({})
    await clock.advance(5_000)
    await clock.settle()
    expect(gh).toEqual([
      { isCached: false, lists: false },
      { isCached: false, lists: false },
    ])
    expect([opens, closed, stored]).toEqual([[], [], []])
    expect(store.get('closedPanes')).toEqual(['simple-work'])
  })

  test('an unknown word is answered with the usage line, and nothing opens or closes', async ($, on) => {
    const { clock, opens, closed, stored } = engine(on)

    await started($, clock)
    await workbench($, '')
    for (const args of ['nonsense here', 'open close', 'work nonsense', 'workbench']) {
      expect(await workbench($, args), args).toEqual({ text: USAGE_LINE })
    }
    expect(opens.length).toBe(2)
    expect([closed, stored.length]).toEqual([[], 1])
  })

  test('is registered to run at once, even while a turn is in flight, with its arguments hinted', async ($, on) => {
    const { clock, specs } = engine(on)

    await started($, clock)
    expect(specs).toEqual([
      {
        name: 'workbench',
        description: expect.stringContaining('side panes'),
        argumentHint: '[work|session] [open|close|refresh]',
        immediate: true,
      },
    ])
  })

  test('passes to the next hook when another plugin holds the name', async ($, on) => {
    const { clock, commands, opens, registered } = engine(on, { ...WORLD, isNameTaken: true })

    await started($, clock)
    // It asked for the name once, and was refused.
    expect(registered).toEqual(['workbench'])
    expect(await workbench($, 'work')).toEqual({})
    expect(commands).toEqual(['workbench'])
    expect(opens).toEqual([])
  })

  test('answers with a line, not an error, when the surface refuses to open a pane', async ($, on) => {
    const { clock, panes } = engine(on, { ...WORLD, refusesOpen: true })

    await started($, clock)
    expect(await workbench($, 'work')).toEqual({ text: 'The side panes could not open: see the debug log.' })
    expect(panes.size).toBe(0)
  })
})

describe('opening the side panes by themselves', () => {
  test('both open on a fullscreen terminal, once', AUTO, async ($, on) => {
    const { clock, opened, panes } = engine(on)

    await started($, clock)

    const fullscreen = await $.ui.mount({ plugin: 'simple', surface: 'terminal', ...HINT, viewport: FULLSCREEN })

    await clock.advance(1_000)
    expect(opened).toEqual(['simple-work', 'simple-session'])

    // The surface loses them (a tab closed from its side); the terminal goes to the main screen and back: not asked again.
    panes.clear()
    await clock.advance(10_000)
    await fullscreen.unmount()

    const main = await $.ui.mount({ plugin: 'simple', surface: 'terminal', ...HINT, viewport: MAIN_SCREEN })

    await clock.advance(1_000)
    await main.unmount()
    await $.ui.mount({ plugin: 'simple', surface: 'terminal', ...HINT, viewport: FULLSCREEN })
    await clock.advance(1_000)
    await clock.settle()
    expect(opened).toEqual(['simple-work', 'simple-session'])
  })

  test('leave a pane the person closed by hand shut, and open the other', AUTO, async ($, on) => {
    const { clock, opened } = engine(on, { ...WORLD, store: { closedPanes: ['simple-work'] } })

    await started($, clock)
    await $.ui.mount({ plugin: 'simple', surface: 'terminal', ...HINT, viewport: FULLSCREEN })
    await clock.advance(1_000)
    expect(opened).toEqual(['simple-session'])
  })

  test('open nothing when the person closed both by hand', AUTO, async ($, on) => {
    const { clock, opened } = engine(on, { ...WORLD, store: { closedPanes: ['simple-work', 'simple-session'] } })

    await started($, clock)
    await $.ui.mount({ plugin: 'simple', surface: 'terminal', ...HINT, viewport: FULLSCREEN })
    await clock.advance(1_000)
    expect(opened).toEqual([])
  })

  test('open nothing on the desktop, on the terminal main screen, or before the terminal says which it is', AUTO, async ($, on) => {
    const { clock, opened } = engine(on)

    await started($, clock)
    for (const [surface, viewport] of [
      ['desktop', FULLSCREEN],
      ['terminal', MAIN_SCREEN],
      ['terminal', undefined],
    ] as const) {
      const ui = await $.ui.mount({ plugin: 'simple', surface, ...HINT, ...(viewport === undefined ? {} : { viewport }) })

      await clock.advance(1_000)
      await ui.unmount()
    }
    expect(opened).toEqual([])
  })

  test('a pane that waits for room counts as open once the surface places it, and then the Work lists are asked', AUTO, async ($, on) => {
    const { clock, opened, gh, panes } = engine(on, { ...WORLD, waits: new Set(['simple-work']) })

    await started($, clock)
    // The 15 s between fresh calls are over, so that a pane counted open would be asked for at once.
    await clock.advance(20_000)
    await $.ui.mount({ plugin: 'simple', surface: 'terminal', ...HINT, viewport: FULLSCREEN })
    await clock.advance(3_000)
    expect(opened).toEqual(['simple-work', 'simple-session'])
    expect(panes.get('simple-work')).toEqual({ isPlaced: false, isShown: false })

    // Waiting is not open: GitHub is not asked for the pane's lists, however long it waits.
    await clock.advance(10_000)
    expect(gh.some(call => call.lists)).toBe(false)

    // The terminal is widened. The panes are read again every five seconds.
    panes.set('simple-work', { isPlaced: true, isShown: true })
    await clock.advance(10_000)
    await clock.settle()
    expect(gh.at(-1)).toEqual({ isCached: false, lists: true })
  })
})

describe('starting', () => {
  test('a run with no one at the prompt and no surface draws nothing and runs nothing', async ($, on) => {
    const { clock, runs, registered } = engine(on, { ...WORLD, surfaces: [] })

    await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
    await clock.advance(60_000)
    await clock.settle()
    expect(runs).toEqual([])
    expect(registered).toEqual([])

    const ui = await $.ui.mount({ plugin: 'simple', surface: 'terminal', ...HINT })

    expect(await rowsOf(ui)).toEqual([])
  })

  test('a run that is drawn on the desktop starts, whoever is at the prompt', async ($, on) => {
    const { clock, runs, registered } = engine(on, { ...WORLD, surfaces: ['desktop'] })

    await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
    await clock.advance(5_000)
    await clock.settle()
    expect(runs).toContain('gh api graphql')
    expect(runs).toContain('python3')
    expect(registered).toEqual(['workbench'])

    const ui = await $.ui.mount({ plugin: 'simple', surface: 'desktop', ...HINT })

    expect(await rowsOf(ui)).toEqual([ROW_1, ROW_2])
  })

  test('a client attaching starts it, and a second client starts nothing more', async ($, on) => {
    const { clock, runs, registered } = engine(on, { ...WORLD, surfaces: [] })
    const looks = () => runs.filter(line => line === 'git rev-parse --show-toplevel --show-prefix --git-dir').length

    await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
    await clock.advance(2_000)
    expect(runs).toEqual([])

    await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
    await clock.advance(2_000)
    await clock.settle()
    expect(looks()).toBe(1)
    expect(registered).toEqual(['workbench'])

    await $.session.attach({ surface: 'desktop', clientId: 'desktop:second' })
    await clock.advance(2_000)
    await clock.settle()
    expect(looks()).toBe(1)
    expect(registered).toEqual(['workbench'])
  })

  test('an editor attaching starts the panes, and nothing for the status line it does not draw until one that draws it attaches', async ($, on) => {
    const { clock, runs, gh, registered } = engine(on, { ...WORLD, surfaces: [] })

    await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
    await $.session.attach({ surface: 'vscode', clientId: 'vscode:default' })
    await clock.advance(5 * 60_000)
    await clock.settle()
    expect(runs).toContain('git rev-parse --show-toplevel --show-prefix --git-dir')
    expect(registered).toEqual(['workbench'])
    // The pull request, the CI and the weekly totals would be drawn nowhere.
    expect(runs).not.toContain('gh api graphql')
    expect(runs).not.toContain('python3')

    // The Work pane is drawn there: GitHub is asked for it.
    await workbench($, 'work')
    await clock.advance(5_000)
    await clock.settle()
    expect(gh).toEqual([{ isCached: false, lists: true }])
    expect(runs).not.toContain('python3')

    // The desktop app attaches: the status line draws, so its weekly totals are read.
    await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
    await clock.advance(5_000)
    await clock.settle()
    expect(runs).toContain('python3')
  })
})
