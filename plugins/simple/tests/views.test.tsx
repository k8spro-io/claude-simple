import { describe, expect, test } from 'claude-code/testing'

import type { AgentCard, CiRun, GateCheck, IssueRef, LogEntry, McpServer, PullRequest, SessionView, Work } from '../hooks/model'
import {
  ago,
  bareTool,
  CHECK_MARKS,
  cells,
  clean,
  clock,
  count,
  cut,
  dotted,
  fit,
  gauge,
  latency,
  layout,
  MERGE_WORDS,
  names,
  reviewOf,
  REVIEW_MARKS,
  scrub,
  shortTool,
  usd,
  worstOutcome,
  type Kit,
  type Part,
} from '../hooks/views/kit'
import { sessionView } from '../hooks/views/session'
import { workView } from '../hooks/views/work'

// The two views are plain functions of a kit of element constructors and plain data. These tests hand them a
// fake kit that builds the same plain-data elements the engine's does (type, props, children; a Button keeps
// its handler aside), read the rows back as text, and press buttons by key. The last describe mounts the
// same trees through the engine's real kit, which refuses what a surface would refuse.

// ---------------------------------------------------------------- a fake surface

type Node = string | El
type El = { type: string; props?: Record<string, unknown>; children?: Node[]; press?: { plugin: string; handle: number } }

/** Elements as the engine builds them: `props` and `children` only when there are some, a Button without its handler. */
function surface() {
  const handlers = new Map<string, (e: never) => void>()
  const flat = (value: unknown): Node[] =>
    Array.isArray(value)
      ? value.flatMap(flat)
      : value === null || value === undefined || typeof value === 'boolean'
        ? []
        : typeof value === 'number'
          ? [String(value)]
          : [value as Node]
  const make = (type: string) => (input: Record<string, unknown>) => {
    const { children, onPress, ...props } = input
    const kids = flat(children)

    if (type === 'Button') {
      handlers.set(String(props.key), onPress as (e: never) => void)
    }

    return {
      type,
      ...(Object.keys(props).length === 0 ? {} : { props }),
      ...(kids.length === 0 ? {} : { children: kids }),
      ...(type === 'Button' ? { press: { plugin: 'fake', handle: handlers.size } } : {}),
    }
  }

  return {
    kit: { Box: make('Box'), Text: make('Text'), Button: make('Button') } as unknown as Kit,
    /** What a press on the Button keyed `key` runs; throws when no such Button was drawn. */
    press: (key: string) => {
      const handler = handlers.get(key)

      if (handler === undefined) {
        throw new Error(`no Button keyed ${key}; the keys are ${[...handlers.keys()].join(', ')}`)
      }
      handler({} as never)
    },
  }
}

/** What a node shows: its strings in order; a plain Button as the terminal draws it, `1: label`. */
function textOf(node: Node): string {
  if (typeof node === 'string') {
    return node
  }
  if (node.type === 'Button') {
    const props = node.props ?? {}

    return `${props.hotkey === undefined ? '' : `${String(props.hotkey)}: `}${String(props.label)}`
  }

  return (node.children ?? []).map(textOf).join('')
}

/** The rows a tree draws, one string each: a row Box is one row, a column Box with a gap leaves empty rows between its children. */
function linesOf(node: Node, options: { skipWrapped?: boolean } = {}): string[] {
  if (typeof node === 'string') {
    return [node]
  }
  if (node.type !== 'Box') {
    return options.skipWrapped === true && node.props?.wrap === 'wrap' ? [] : [textOf(node)]
  }

  const children = node.children ?? []

  if (node.props?.flexDirection === 'row') {
    return [children.map(textOf).join(' ')]
  }

  const gap = typeof node.props?.gap === 'number' ? node.props.gap : 0

  return children.flatMap((child, index) => [...(index > 0 ? Array<string>(gap).fill('') : []), ...linesOf(child, options)])
}

const rowsOf = (tree: unknown, options: { skipWrapped?: boolean } = {}): string[] => linesOf(tree as Node, options)

function walk(node: Node, visit: (el: El, depth: number) => void, depth = 1): void {
  if (typeof node === 'string') {
    return
  }
  visit(node, depth)
  for (const child of node.children ?? []) {
    walk(child, visit, depth + 1)
  }
}

/** Every element of a tree, in document order, of one type when given. */
function all(tree: unknown, type?: string): El[] {
  const found: El[] = []

  walk(tree as Node, el => {
    if (type === undefined || el.type === type) {
      found.push(el)
    }
  })

  return found
}

/** The Text that reads exactly `text`. */
function textRow(tree: unknown, text: string): El {
  const found = all(tree, 'Text').find(el => textOf(el) === text)

  if (found === undefined) {
    throw new Error(`no row reads ${JSON.stringify(text)}; the rows are\n${rowsOf(tree).join('\n')}`)
  }

  return found
}

/** The Button keyed `key`. */
function buttonAt(tree: unknown, key: string): El {
  const found = all(tree, 'Button').find(el => el.props?.key === key)

  if (found === undefined) {
    throw new Error(
      `no Button keyed ${key}; the keys are ${all(tree, 'Button')
        .map(el => String(el.props?.key))
        .join(', ')}`,
    )
  }

  return found
}

type Span = { text: string; color?: unknown; bold?: unknown; dim?: unknown }

/** What a row is made of: its inline pieces and the style each is drawn in. */
function spansOf(row: El): Span[] {
  return (row.children ?? []).map(child =>
    typeof child === 'string'
      ? { text: child }
      : {
          text: textOf(child),
          ...(child.props?.color === undefined ? {} : { color: child.props.color }),
          ...(child.props?.bold === undefined ? {} : { bold: child.props.bold }),
          ...(child.props?.dimColor === undefined ? {} : { dim: child.props.dimColor }),
        },
  )
}

/** The piece of the row `text` that holds `fragment`. */
function pieceOf(tree: unknown, text: string, fragment: string): Span {
  const found = spansOf(textRow(tree, text)).find(one => one.text.includes(fragment))

  if (found === undefined) {
    throw new Error(`the row ${JSON.stringify(text)} has no piece holding ${JSON.stringify(fragment)}`)
  }

  return found
}

const ESC = String.fromCharCode(0x1b)

/** Free text as an attacker, or just a sloppy tool, could send it: an escape sequence, controls, a bidi override, zero-width marks. */
const dirty = (word: string) =>
  [
    `${ESC}[31m`,
    word,
    `${ESC}[0m`,
    '\n',
    '\t',
    String.fromCharCode(0),
    String.fromCharCode(0x9b),
    String.fromCharCode(0x202e),
    String.fromCharCode(0x200b),
    `${ESC}]0;owned${String.fromCharCode(7)}`,
  ].join('')

/** Every string a tree carries: text children and prop values. */
function stringsOf(tree: unknown): string[] {
  const found: string[] = []

  walk(tree as Node, el => {
    for (const child of el.children ?? []) {
      if (typeof child === 'string') {
        found.push(child)
      }
    }
    for (const value of Object.values(el.props ?? {})) {
      if (typeof value === 'string') {
        found.push(value)
      }
    }
  })

  return found
}

const CONTROL = /[\u{0}-\u{1f}\u{7f}-\u{9f}]/u
const INVISIBLE = /[\u{61c}\u{200b}-\u{200f}\u{2028}-\u{202e}\u{2060}-\u{2069}\u{feff}]/u

// ---------------------------------------------------------------- fixtures

const NOW = Date.parse('2026-10-07T12:00:00Z')
const SEC = 1000
const MIN = 60 * SEC
const HOUR = 60 * MIN

const pr = (change: Partial<PullRequest>): PullRequest => ({
  number: 1,
  title: 'Title',
  url: '',
  author: 'alice',
  branch: 'topic',
  isDraft: false,
  review: null,
  reviewers: [],
  reviews: [],
  checks: [],
  merge: 'clean',
  isAutoMerge: false,
  closes: [],
  updatedAt: '2026-10-07T11:00:00Z',
  ...change,
})

const ticket = (change: Partial<IssueRef>): IssueRef => ({
  number: 12,
  title: 'Add a login form',
  state: 'open',
  url: 'https://github.com/acme/widgets/issues/12',
  labels: [],
  assignees: [],
  source: 'branch',
  ...change,
})

const MINE = pr({
  number: 42,
  title: 'Add the login form',
  url: 'https://github.com/acme/widgets/pull/42',
  author: 'octocat',
  branch: 'feat/12-login-form',
  review: 'pending',
  reviewers: ['alice', 'bob'],
  reviews: [
    { author: 'carol', state: 'approved' },
    { author: 'dave', state: 'changes_requested' },
  ],
  checks: [
    { name: 'build', outcome: 'passed' },
    { name: 'unit-tests', outcome: 'passed' },
    { name: 'lint', outcome: 'failed' },
    { name: 'e2e (chrome)', outcome: 'failed' },
    { name: 'deploy-preview', outcome: 'pending' },
  ],
  merge: 'behind',
  base: 'main',
  isAutoMerge: true,
  closes: [12],
})

const CI: CiRun = { workflow: 'build', outcome: 'passed', isRunning: false, at: NOW - 2 * MIN, url: '', sha: 'a1b2c3d' }

const WORK: Work = {
  repo: 'acme/widgets',
  branch: 'feat/12-login-form',
  tickets: [ticket({ labels: ['feature', 'ui'], assignees: ['octocat'] })],
  pr: MINE,
  ci: CI,
  board: [
    MINE,
    pr({ number: 40, title: 'Bump the toolchain', author: 'alice', review: 'approved', checks: [{ name: 'build', outcome: 'passed' }] }),
    pr({
      number: 41,
      title: 'Cache the lookups for the search page',
      author: 'bob',
      review: 'changes_requested',
      checks: [{ name: 'build', outcome: 'failed' }],
      closes: [7],
    }),
    pr({ number: 43, title: 'Retry policy', author: 'carol', isDraft: true, review: 'draft', merge: 'draft' }),
  ],
  unstarted: [
    { number: 7, title: 'Retry failed uploads', url: '', assignees: [], labels: [], updatedAt: '2026-10-07T08:00:00Z', inPr: null },
    { number: 9, title: 'Document the config file', url: '', assignees: [], labels: [], updatedAt: '2026-10-07T08:00:00Z', inPr: 44 },
  ],
  reviewQueue: [pr({ number: 38, title: 'Fix the cache key', author: 'dave', updatedAt: '2026-10-07T09:00:00Z' })],
  fetchedAt: NOW - 3 * MIN,
  problem: null,
  totals: null,
  canRetry: false,
}

const EMPTY_WORK: Work = {
  repo: 'acme/widgets',
  branch: 'main',
  tickets: [],
  pr: null,
  ci: null,
  board: [],
  unstarted: [],
  reviewQueue: [],
  fetchedAt: NOW - 10 * SEC,
  problem: null,
  totals: null,
  canRetry: false,
}

const agent = (change: Partial<AgentCard>): AgentCard => ({
  id: 'a1',
  type: 'explorer',
  description: 'Map the module graph',
  model: 'claude-sonnet-5-5',
  status: 'running',
  startedAt: NOW - 80 * SEC,
  endedAt: null,
  steps: 12,
  contextTokens: 48_000,
  outputTokens: 3100,
  tools: [],
  answer: '',
  ...change,
})

const check = (id: string, verdict: GateCheck['verdict'], change: Partial<GateCheck> = {}): GateCheck => ({
  id,
  tool: 'Bash',
  family: 'shell',
  verdict,
  inSubagent: false,
  detail: 'ls',
  at: NOW - 10 * MIN,
  ...change,
})

const checks = (n: number, verdict: GateCheck['verdict'], change: Partial<GateCheck> = {}): GateCheck[] =>
  Array.from({ length: n }, (_, index) => check(`${verdict}-${index}`, verdict, change))

const server = (change: Partial<McpServer>): McpServer => ({
  server: 'docs',
  calls: 12,
  errors: 2,
  subagentCalls: 3,
  totalMs: 5040,
  maxMs: 1800,
  lastMs: 300,
  lastTool: 'search',
  lastAt: NOW - 12 * SEC,
  inFlight: [],
  ...change,
})

const entry = (kind: LogEntry['kind'], at: number, who: string, text: string): LogEntry => ({ at, kind, who, text, agentId: null })

const SESSION: SessionView = {
  receipt: { isRunning: true, startedAt: NOW - 65 * SEC, durationMs: null, agents: 2, edits: 3, errors: 1, costUsd: null },
  compactions: 2,
  mcp: [
    server({ inFlight: [{ id: 'c1', tool: 'mcp__docs__fetch', startedAt: NOW - 4200 }] }),
    server({
      server: 'files',
      calls: 3,
      errors: 0,
      totalMs: 120,
      maxMs: 90,
      lastAt: NOW - 5 * MIN,
      inFlight: [{ id: 'c2', tool: 'list', startedAt: NOW - 65 * SEC }],
    }),
  ],
  agents: [
    agent({
      tools: [
        { tool: 'Grep', text: 'needle in src', isError: false },
        { tool: 'Bash', text: 'npm test', isError: true },
      ],
    }),
    agent({
      id: 'a2',
      type: 'reviewer',
      description: 'Check the diff',
      status: 'done',
      startedAt: NOW - 160 * SEC,
      endedAt: NOW - 30 * SEC,
      answer: 'Looks fine. Two nits: rename foo to bar, and add a test for the empty case.',
      tools: [
        { tool: 'Read', text: 'a.ts', isError: false },
        { tool: 'Read', text: 'b.ts', isError: false },
        { tool: 'Grep', text: 'foo', isError: false },
        { tool: 'Bash', text: 'git diff', isError: false },
      ],
    }),
  ],
  gate: [
    ...checks(6, 'rule'),
    check('asked-1', 'asked', { tool: 'Edit', detail: 'src/a.ts' }),
    ...checks(2, 'rule', { inSubagent: true }),
    check('denied-1', 'denied', { detail: 'rm -rf build' }),
    check('pending-1', 'pending'),
  ],
  log: [
    entry('prompt', NOW - 3 * HOUR, 'you', 'fix the login form'),
    entry('spawn', NOW - 5 * MIN, 'main', 'explorer: Map the module graph'),
    entry('edit', NOW - 3 * MIN, 'main', 'src/login.ts'),
    entry('error', NOW - 100 * SEC, 'explorer', 'npm test failed'),
    entry('denied', NOW - 40 * SEC, 'main', 'rm -rf build'),
    entry('done', NOW - 30 * SEC, 'reviewer', 'Check the diff'),
    entry('git', NOW - 12 * SEC, 'main', 'commit abc123'),
    entry('compact', NOW - 2 * SEC, 'main', 'context compacted'),
  ],
  tools: [
    { name: 'Bash', count: 12 },
    { name: 'Read', count: 30 },
    { name: 'mcp__docs__search', count: 10 },
  ],
}

const EMPTY_SESSION: SessionView = { mcp: [], agents: [], gate: [], log: [], receipt: null, compactions: 0, tools: [] }

// ---------------------------------------------------------------- drawing

type Calls = { refreshed: number; copied: string[]; expanded: (string | null)[] }

/** Draws the Work tab on a fake surface; `press` runs the handler of a Button by key. */
function drawWork(work: Work | null, change: { width?: number; nowMs?: number } = {}) {
  const calls: Calls = { refreshed: 0, copied: [], expanded: [] }
  const { kit, press } = surface()
  const tree = workView(kit, work, {
    nowMs: change.nowMs ?? NOW,
    width: change.width ?? 60,
    onRefresh: () => {
      calls.refreshed += 1
    },
    onCopy: url => {
      calls.copied.push(url)
    },
  })

  return { tree, rows: rowsOf(tree), calls, press }
}

/** Draws the Session tab on a fake surface. */
function drawSession(s: SessionView, change: { width?: number; nowMs?: number; expanded?: string | null; logRows?: number } = {}) {
  const calls: Calls = { refreshed: 0, copied: [], expanded: [] }
  const { kit, press } = surface()
  const tree = sessionView(kit, s, {
    nowMs: change.nowMs ?? NOW,
    width: change.width ?? 60,
    expanded: change.expanded ?? null,
    onExpand: id => {
      calls.expanded.push(id)
    },
    ...(change.logRows === undefined ? {} : { logRows: change.logRows }),
  })

  return { tree, rows: rowsOf(tree), calls, press }
}

// ---------------------------------------------------------------- the kit's formats

describe('kit formats', () => {
  test('ago is one short figure: seconds, minutes, hours, days; never negative', () => {
    expect(ago(NOW, NOW - 12 * SEC)).toBe('12s')
    expect(ago(NOW, NOW - 59_999)).toBe('59s')
    expect(ago(NOW, NOW - MIN)).toBe('1m')
    expect(ago(NOW, NOW - 3 * MIN - 40 * SEC)).toBe('3m')
    expect(ago(NOW, NOW - 59 * MIN)).toBe('59m')
    expect(ago(NOW, NOW - HOUR)).toBe('1h')
    expect(ago(NOW, NOW - 23 * HOUR - 59 * MIN)).toBe('23h')
    expect(ago(NOW, NOW - 24 * HOUR)).toBe('1d')
    expect(ago(NOW, NOW - 4 * 24 * HOUR)).toBe('4d')
    expect(ago(NOW, NOW + 5 * MIN)).toBe('0s')
    expect(ago(NOW, Number.NaN)).toBe('')
    expect(ago(NOW, 0)).toBe('')
    expect(ago(NOW, -5)).toBe('')
    expect(ago(Number.NaN, NOW)).toBe('')
  })

  test('clock is the elapsed time as a person reads a stopwatch', () => {
    expect(clock(0)).toBe('0s')
    expect(clock(45_000)).toBe('45s')
    expect(clock(65_000)).toBe('1m05s')
    expect(clock(130_000)).toBe('2m10s')
    expect(clock(3_599_000)).toBe('59m59s')
    expect(clock(3_725_000)).toBe('1h02m')
    expect(clock(-5)).toBe('0s')
    expect(clock(Number.NaN)).toBe('0s')
  })

  test('latency is milliseconds under a second, then seconds, then a clock past a minute', () => {
    expect(latency(0)).toBe('0ms')
    expect(latency(820)).toBe('820ms')
    expect(latency(999.6)).toBe('1.0s')
    expect(latency(1000)).toBe('1.0s')
    expect(latency(1400)).toBe('1.4s')
    expect(latency(9949)).toBe('9.9s')
    expect(latency(9950)).toBe('10s')
    expect(latency(12_000)).toBe('12s')
    expect(latency(59_400)).toBe('59s')
    expect(latency(59_960)).toBe('1m00s')
    expect(latency(125_000)).toBe('2m05s')
    expect(latency(-1)).toBe('0ms')
    expect(latency(Number.NaN)).toBe('0ms')
  })

  test('count pluralizes, usd rounds to cents, names lists a few and counts the rest', () => {
    expect(count(1, 'call')).toBe('1 call')
    expect(count(0, 'call')).toBe('0 calls')
    expect(count(2, 'agent')).toBe('2 agents')
    expect(usd(0.4213)).toBe('$0.42')
    expect(usd(12)).toBe('$12.00')
    expect(usd(Number.NaN)).toBe('$0.00')
    expect(names(['alice', 'bob'], 3)).toBe('alice, bob')
    expect(names(['alice', 'bob', 'carol', 'dave', 'erin'], 3)).toBe('alice, bob, carol +2')
    expect(names(['alice', '', '  '], 3)).toBe('alice')
    expect(names([], 3)).toBe('')
  })

  test('gauge fills the nearest cell and clamps what is out of range', () => {
    expect(gauge(50, 4)).toBe('▰▰▱▱')
    expect(gauge(0, 4)).toBe('▱▱▱▱')
    expect(gauge(100, 4)).toBe('▰▰▰▰')
    expect(gauge(40, 5)).toBe('▰▰▱▱▱')
    expect(gauge(180, 3)).toBe('▰▰▰')
    expect(gauge(-20, 3)).toBe('▱▱▱')
    expect(gauge(Number.NaN, 3)).toBe('▱▱▱')
    expect(gauge(50, 0)).toBe('')
  })

  test('shortTool and bareTool drop the mcp prefix the way each row needs', () => {
    expect(shortTool('mcp__docs__search')).toBe('docs:search')
    expect(shortTool('Bash')).toBe('Bash')
    expect(bareTool('mcp__docs__search')).toBe('search')
    expect(bareTool('search')).toBe('search')
  })

  test('scrub takes escape sequences and control characters out, clean also tidies whitespace', () => {
    const esc = String.fromCharCode(0x1b)
    const bel = String.fromCharCode(0x07)

    expect(scrub(`${esc}[31mred${esc}[0m`)).toBe('red')
    expect(scrub(`${esc}]0;title${bel}after`)).toBe('after')
    expect(scrub(`a${String.fromCharCode(0x9b)}31mb`)).toBe('ab')
    expect(scrub(`x${String.fromCharCode(0)}y`)).toBe('xy')
    expect(scrub('two\nlines\tand\ttabs')).toBe('two lines and tabs')
    expect(scrub(`a${String.fromCharCode(0x202e)}b${String.fromCharCode(0x200b)}c${String.fromCharCode(0x2028)}d`)).toBe('abc d')
    expect(scrub('  keeps  spaces  ')).toBe('  keeps  spaces  ')
    expect(clean('  one \n two\t\tthree  ')).toBe('one two three')
    expect(clean(`${esc}[1m  bold  ${esc}[0m`)).toBe('bold')
  })

  test('cells counts wide characters twice and cut ends what it cuts with an ellipsis', () => {
    expect(cells('abc')).toBe(3)
    expect(cells('✓ ●')).toBe(3)
    expect(cells('日本語')).toBe(6)
    expect(cells('a😀b')).toBe(4)
    expect(cells('e\u{301}')).toBe(1)
    expect(cut('abcdef', 6)).toBe('abcdef')
    expect(cut('abcdef', 4)).toBe('abc…')
    expect(cut('abcdef', 1)).toBe('…')
    expect(cut('abcdef', 0)).toBe('')
    expect(cut('日本語日本語', 5)).toBe('日本…')
    expect(cut('a b c d', 4)).toBe('a b…')
  })

  test('fit drops the highest rank first, cuts the flexible part to its minimum, then cuts the end', () => {
    const row: Part[] = [
      { text: '#1' },
      { text: ' a long pull request title', min: 8 },
      { text: ' · alice', drop: 1 },
      { text: ' · closes #12', drop: 2 },
    ]
    const text = (width: number) =>
      fit(row, width)
        .map(part => part.text)
        .join('')

    expect(text(60)).toBe('#1 a long pull request title · alice · closes #12')
    // The title shrinks first, down to its minimum of 8 cells; nothing leaves while that is enough.
    expect(text(40)).toBe('#1 a long pull req… · alice · closes #12')
    expect(text(31)).toBe('#1 a long… · alice · closes #12')
    // Below that the closing part leaves, then the author, and the title takes what is left.
    expect(text(30)).toBe('#1 a long pull reques… · alice')
    expect(text(17)).toBe('#1 a long pull r…')
    expect(text(10)).toBe('#1 a long…')
    // With nothing left to leave, the end of the row is cut.
    expect(text(9)).toBe('#1 a lon…')
    expect(text(3)).toBe('#1…')
    expect(text(0)).toBe('')
    expect(
      fit(row, Number.NaN)
        .map(part => part.text)
        .join(''),
    ).toBe(text(60))
  })

  test('fit drops the later of two parts with the same rank first', () => {
    const text = (width: number) =>
      fit([{ text: 'ab' }, { text: ' cd', drop: 1 }, { text: ' ef', drop: 1 }], width)
        .map(part => part.text)
        .join('')

    expect(text(8)).toBe('ab cd ef')
    expect(text(5)).toBe('ab cd')
    expect(text(2)).toBe('ab')
  })

  test('fit ends a row that still overflows with an ellipsis, wide characters counted', () => {
    expect(fit([{ text: '日本語日本語' }], 7).map(part => part.text)).toEqual(['日本語…'])
    expect(fit([{ text: 'ab' }, { text: 'cdefg' }], 5).map(part => part.text)).toEqual(['ab', 'cd…'])
  })

  test('dotted joins with a separator, leaves out what is empty, and keeps the head apart', () => {
    const texts = (parts: Part[]) => parts.map(part => part.text)

    expect(texts(dotted([{ text: 'a' }, null, { text: '' }, { text: 'b' }]))).toEqual(['a', ' · b'])
    expect(texts(dotted([{ text: 'a' }, { text: 'b' }], true))).toEqual([' · a', ' · b'])
    expect(texts(dotted([null, { text: 'a' }]))).toEqual(['a'])
    // Without a head the first part stays, whatever its rank: a row never opens with a separator.
    expect(dotted([null, { text: 'a', drop: 2 }, { text: 'b', drop: 1 }]).map(part => part.drop)).toEqual([undefined, 1])
    expect(dotted([{ text: 'a', drop: 2 }], true).map(part => part.drop)).toEqual([2])
    expect(
      fit([{ text: '  ' }, ...dotted([{ text: 'bug', drop: 2 }, { text: 'alice', drop: 1 }, { text: 'from PR' }])], 18)
        .map(part => part.text)
        .join(''),
    ).toBe('  bug · from PR')
  })

  test('worstOutcome ranks failed over pending over passed over skipped', () => {
    const outcomes = (...list: ('passed' | 'failed' | 'pending' | 'skipped')[]) =>
      list.map((outcome, index) => ({ name: `c${index}`, outcome }))

    expect(worstOutcome([])).toBeNull()
    expect(worstOutcome(outcomes('skipped'))).toBe('skipped')
    expect(worstOutcome(outcomes('skipped', 'passed'))).toBe('passed')
    expect(worstOutcome(outcomes('passed', 'pending', 'skipped'))).toBe('pending')
    expect(worstOutcome(outcomes('pending', 'failed', 'passed'))).toBe('failed')
  })

  test('the marks and words are the vocabulary the panes speak', () => {
    expect(Object.entries(REVIEW_MARKS).map(([state, one]) => [state, one.mark, one.words, one.color])).toEqual([
      ['approved', '✓', 'approved', 'success'],
      ['changes_requested', '✗', 'changes requested', 'error'],
      ['pending', '○', 'review pending', 'warning'],
      ['draft', '◌', 'draft', 'inactive'],
    ])
    expect(Object.entries(CHECK_MARKS).map(([outcome, one]) => [outcome, one.mark, one.color])).toEqual([
      ['passed', '✓', 'success'],
      ['failed', '✗', 'error'],
      ['pending', '●', 'warning'],
      ['skipped', '–', 'inactive'],
    ])
    expect(Object.entries(MERGE_WORDS).map(([state, one]) => [state, one.words])).toEqual([
      ['clean', 'ready'],
      ['behind', 'behind main'],
      ['dirty', 'conflicts'],
      ['blocked', 'blocked'],
      ['unstable', 'unstable'],
      ['draft', 'draft'],
      ['unknown', 'unknown'],
    ])
    expect(reviewOf({ isDraft: true, review: 'approved' })).toBe(REVIEW_MARKS.draft)
    expect(reviewOf({ isDraft: false, review: 'approved' })).toBe(REVIEW_MARKS.approved)
    expect(reviewOf({ isDraft: false, review: null })).toBeNull()
  })

  test('header, subheader and empty are bold and muted rows over the kit', () => {
    const { kit } = surface()
    const ui = layout(kit, 30)

    expect(spansOf(ui.header('Agents', '2 running') as El)).toEqual([
      { text: 'Agents', color: 'claude', bold: true },
      { text: ' 2 running', color: 'inactive' },
    ])
    expect(spansOf(ui.header('Turn') as El)).toEqual([{ text: 'Turn', color: 'claude', bold: true }])
    expect(spansOf(ui.subheader('Not started', '3') as El)).toEqual([
      { text: 'Not started', color: 'inactive', bold: true },
      { text: ' 3', color: 'inactive' },
    ])
    expect(spansOf(ui.empty('nothing here') as El)).toEqual([{ text: 'nothing here', color: 'inactive' }])
  })

  test('a button is plain, carries a hotkey and dimness only when given, and runs its callback without the press', () => {
    const { kit, press } = surface()
    const ui = layout(kit, 30)
    const seen: unknown[][] = []
    const bare = ui.button({ key: 'bare', label: 'Bare', onPress: (...args: unknown[]) => void seen.push(args) } as never) as El
    const full = ui.button({ key: 'full', label: 'Full', hotkey: '3', dim: true, onPress: () => undefined }) as El

    expect(bare.props).toEqual({ key: 'bare', label: 'Bare', plain: true })
    expect(full.props).toEqual({ key: 'full', label: 'Full', plain: true, hotkey: '3', dimColor: true })
    press('bare')
    expect(seen).toEqual([[]])
    expect(textOf(full)).toBe('3: Full')
  })

  test('a row with a button leaves it room, and a hotkey takes three cells more', () => {
    const { kit } = surface()
    const ui = layout(kit, 20)
    const row = ui.withButton([{ text: 'x'.repeat(40) }], { key: 'go', label: '↻ 3m', onPress: () => undefined }) as El
    const keyed = ui.withButton([{ text: 'x'.repeat(40) }], { key: 'go', label: '↻ 3m', hotkey: 'g', onPress: () => undefined }) as El

    expect(row.props).toEqual({ flexDirection: 'row', justifyContent: 'space-between' })
    expect(linesOf(row)).toEqual([`${'x'.repeat(14)}… ↻ 3m`])
    expect(linesOf(keyed)).toEqual([`${'x'.repeat(11)}… g: ↻ 3m`])
    expect(cells(linesOf(row)[0] ?? '')).toBe(20)
    expect(cells(linesOf(keyed)[0] ?? '')).toBe(20)
  })

  test('wrapped text is cut to the characters it is given, scrubbed, muted, and indented through a Box', () => {
    const { kit } = surface()
    const ui = layout(kit, 30)
    const plain = ui.wrapped(`some ${ESC}[1mwords${ESC}[0m to wrap`, { chars: 100 }) as El
    const cutDown = ui.wrapped('a'.repeat(50), { chars: 20, color: 'warning' }) as El
    const pushed = ui.wrapped('words', { chars: 20, indent: 3 }) as El

    expect(plain).toMatchObject({ type: 'Text', props: { wrap: 'wrap', color: 'inactive' } })
    expect(textOf(plain)).toBe('some words to wrap')
    expect(cutDown.props).toMatchObject({ wrap: 'wrap', color: 'warning' })
    expect(textOf(cutDown)).toBe(`${'a'.repeat(19)}…`)
    expect(pushed).toMatchObject({ type: 'Box', props: { flexDirection: 'column', paddingLeft: 3 } })
    expect(textOf(pushed)).toBe('words')
  })

  test('every builder scrubs what it is given, so a stray escape sequence never reaches the engine', () => {
    const { kit } = surface()
    const ui = layout(kit, 40)
    const bad = `${ESC}[31mred${ESC}[0m\n\t${String.fromCharCode(0)}x`
    const drawn = [
      ui.line([{ text: bad }]),
      ui.header(bad, bad),
      ui.subheader(bad, bad),
      ui.empty(bad),
      ui.wrapped(bad, { chars: 50, indent: 2 }),
      ui.button({ key: 'k', label: bad, onPress: () => undefined }),
      ui.withButton([{ text: bad }], { key: 'w', label: bad, onPress: () => undefined }),
    ]

    for (const tree of drawn) {
      for (const text of stringsOf(tree)) {
        expect(CONTROL.test(text), JSON.stringify(text)).toBe(false)
      }
    }
    expect(rowsOf(drawn[0])).toEqual(['red  x'])
    expect(rowsOf(drawn[3])).toEqual(['red  x'])
    expect(rowsOf(drawn[5])).toEqual(['red  x'])
    expect(rowsOf(drawn[6])).toEqual(['red  x red  x'])
  })

  test('layout takes a width that is no use as the default and builds rows over the kit it is given', () => {
    const { kit } = surface()

    expect(layout(kit, 0).room).toBe(40)
    expect(layout(kit, -3).room).toBe(40)
    expect(layout(kit, Number.NaN).room).toBe(40)
    expect(layout(kit, 33.9).room).toBe(33)

    const ui = layout(kit, 20)
    const tree = ui.line([{ text: 'x'.repeat(40) }])

    expect(rowsOf(tree)).toEqual([`${'x'.repeat(19)}…`])
    expect(tree).toMatchObject({ type: 'Text', props: { wrap: 'truncate-end' } })
  })
})

// ---------------------------------------------------------------- the Work tab

/** The rows of one section, its header left out: from the row after the header to the next empty row. */
function sectionOf(rows: string[], title: string): string[] {
  const start = rows.findIndex(row => row === title || row.startsWith(`${title} `))

  if (start < 0) {
    throw new Error(`no section ${title}; the rows are\n${rows.join('\n')}`)
  }

  const end = rows.indexOf('', start)

  return rows.slice(start + 1, end < 0 ? undefined : end)
}

const withPr = (change: Partial<PullRequest>): Work => ({ ...EMPTY_WORK, pr: pr({ number: 5, title: 'Tidy up', ...change }) })

describe('work view', () => {
  test('draws the title row and every section in order, an empty line between them', () => {
    const { rows, tree } = drawWork(WORK)

    expect(rows).toEqual([
      'acme/widgets · feat/12-login-form ↻ 3m',
      '',
      'Ticket',
      '#12 Add a login form',
      '  open · feature, ui · octocat · from branch',
      '',
      'Pull request',
      '#42 Add the login form ⧉',
      '○ review pending · waiting on alice, bob',
      'reviews ✓ carol  ✗ dave',
      'merge behind main · auto-merge on',
      'checks ▰▰▱▱▱ ✗ 2 failed · ● 1 pending · ✓ 2 passed',
      '  ✗ lint',
      '  ✗ e2e (chrome)',
      '  ● deploy-preview',
      '',
      'CI',
      '✓ build · 2m ago · a1b2c3d',
      '',
      'Team board 4 open',
      '○ ✗ #42 Add the login form · octocat · closes #12',
      '✓ ✓ #40 Bump the toolchain · alice',
      '✗ ✗ #41 Cache the lookups for the search… · bob · closes #7',
      '◌ #43 Retry policy · carol',
      'Assigned to you 2',
      '#7 Retry failed uploads · no PR yet',
      '#9 Document the config file · PR #44',
      '',
      'Review queue 1',
      '#38 Fix the cache key · dave · 3h',
    ])
    expect(tree).toMatchObject({ type: 'Box', props: { flexDirection: 'column', gap: 1 } })
  })

  test('has a refresh button that says how old the data is and asks the lane to read again', () => {
    const fresh = drawWork(WORK)
    const button = buttonAt(fresh.tree, 'refresh')

    expect(button.props).toMatchObject({ key: 'refresh', label: '↻ 3m', plain: true })
    expect(fresh.calls.refreshed).toBe(0)
    fresh.press('refresh')
    expect(fresh.calls.refreshed).toBe(1)
    fresh.press('refresh')
    expect(fresh.calls.refreshed).toBe(2)
    expect(fresh.calls.copied).toEqual([])
    expect(buttonAt(drawWork({ ...WORK, fetchedAt: NOW - 45 * SEC }).tree, 'refresh').props?.label).toBe('↻ 45s')
    expect(buttonAt(drawWork({ ...WORK, fetchedAt: NOW - 2 * HOUR }).tree, 'refresh').props?.label).toBe('↻ 2h')
    // The age moves on when the view is drawn at a later time.
    expect(buttonAt(drawWork(WORK, { nowMs: NOW + 7 * MIN }).tree, 'refresh').props?.label).toBe('↻ 10m')
  })

  test('shows the repository in bold blue and the branch in magenta, whichever of them is known', () => {
    const { tree } = drawWork(WORK)

    expect(spansOf(textRow(tree, 'acme/widgets · feat/12-login-form'))).toEqual([
      { text: 'acme/widgets', color: 'blue', bold: true },
      { text: ' · ', color: 'inactive' },
      { text: 'feat/12-login-form', color: 'magenta' },
    ])
    expect(drawWork({ ...EMPTY_WORK, repo: null, branch: 'main' }).rows[0]).toBe('main ↻ 10s')
    expect(drawWork({ ...EMPTY_WORK, branch: null }).rows[0]).toBe('acme/widgets ↻ 10s')
    expect(drawWork({ ...EMPTY_WORK, repo: null, branch: null }).rows[0]).toBe('no repository ↻ 10s')
  })

  test('keeps the refresh button in view on a narrow pane and cuts the branch instead', () => {
    expect(drawWork(WORK, { width: 24 }).rows[0]).toBe('acme/widgets · fea… ↻ 3m')
    // A repository name that is itself too long takes the whole room.
    expect(drawWork({ ...WORK, repo: 'acme/widgets-with-a-very-long-name' }, { width: 30 }).rows[0]).toBe('acme/widgets-with-a-very… ↻ 3m')
  })

  test('names the branch tickets with their state, labels, assignees and where each came from', () => {
    const work: Work = {
      ...EMPTY_WORK,
      tickets: [
        ticket({ source: 'commit', state: 'closed', labels: ['bug'], assignees: ['alice', 'bob'] }),
        ticket({ number: 13, title: '', state: '', labels: [], assignees: [], source: 'pr' }),
      ],
    }
    const { rows, tree } = drawWork(work)

    expect(rows.slice(2, 7)).toEqual(['Ticket 2', '#12 Add a login form', '  closed · bug · alice, bob · from commit', '#13', '  from PR'])
    expect(pieceOf(tree, '#12 Add a login form', '#12').color).toBe('cyan')
    expect(pieceOf(tree, '  closed · bug · alice, bob · from commit', 'closed').color).toBe('inactive')
    expect(pieceOf(tree, '  closed · bug · alice, bob · from commit', 'from commit').color).toBe('inactive')
  })

  test('shows three tickets and counts the rest', () => {
    const many = Array.from({ length: 5 }, (_, index) => ticket({ number: 20 + index, title: `Ticket ${index}`, source: 'pr' }))
    const { rows } = drawWork({ ...EMPTY_WORK, tickets: many })

    expect(sectionOf(rows, 'Ticket')).toEqual([
      '#20 Ticket 0',
      '  open · from PR',
      '#21 Ticket 1',
      '  open · from PR',
      '#22 Ticket 2',
      '  open · from PR',
      '+2 more',
    ])
  })

  test('never opens the ticket details with a separator, even when the state is not known', () => {
    const work: Work = { ...EMPTY_WORK, tickets: [ticket({ state: '', labels: ['bug', 'ui'], assignees: ['alice'] })] }
    const details = (width: number) => sectionOf(drawWork(work, { width }).rows, 'Ticket')[1]

    expect(details(60)).toBe('  bug, ui · alice · from branch')
    // The labels lead in place of the state, so the assignees give way and the labels stay.
    expect(details(30)).toBe('  bug, ui · from branch')
    expect(details(20)).toBe('  bug, ui · from br…')
  })

  test('warns when the branch has no ticket, in the warning color, and drops the advice before cutting the warning', () => {
    const { rows, tree } = drawWork(EMPTY_WORK)

    expect(sectionOf(rows, 'Ticket')).toEqual(['no ticket linked: add "Closes #N" to the PR'])
    expect(spansOf(textRow(tree, 'no ticket linked: add "Closes #N" to the PR')).map(one => one.color)).toEqual(['warning', 'warning'])
    expect(sectionOf(drawWork(EMPTY_WORK, { width: 30 }).rows, 'Ticket')).toEqual(['no ticket linked'])
  })

  test('says there is no pull request, with no copy button, when the branch has none', () => {
    const { rows, tree } = drawWork(EMPTY_WORK)

    expect(sectionOf(rows, 'Pull request')).toEqual(['no open PR for this branch'])
    expect(pieceOf(tree, 'no open PR for this branch', 'no open PR').color).toBe('inactive')
    expect(all(tree, 'Button').map(button => button.props?.key)).toEqual(['refresh'])
  })

  test('has a button that copies the pull request url, and none when the pull request has no url', () => {
    const { tree, calls, press } = drawWork(WORK)

    expect(buttonAt(tree, 'copy-pr').props).toMatchObject({ key: 'copy-pr', label: '⧉', plain: true })
    press('copy-pr')
    expect(calls.copied).toEqual(['https://github.com/acme/widgets/pull/42'])
    expect(all(drawWork(withPr({ url: '' })).tree, 'Button').map(button => button.props?.key)).toEqual(['refresh'])
  })

  test('reads the review as a mark and words, and who is still asked', () => {
    const cases: [Partial<PullRequest>, string, string][] = [
      [{ review: 'approved' }, '✓ approved', 'success'],
      [{ review: 'changes_requested' }, '✗ changes requested', 'error'],
      [{ review: 'pending', reviewers: ['alice'] }, '○ review pending · waiting on alice', 'warning'],
      [
        { review: 'pending', reviewers: ['alice', 'bob', 'carol', 'dave', 'erin'] },
        '○ review pending · waiting on alice, bob, carol +2',
        'warning',
      ],
      [{ review: 'draft', isDraft: true, merge: 'draft' }, '◌ draft', 'inactive'],
      [{ isDraft: true, review: 'approved', merge: 'draft' }, '◌ draft', 'inactive'],
      [{ review: null }, 'no review required', 'inactive'],
    ]

    for (const [change, words, color] of cases) {
      const { rows, tree } = drawWork(withPr(change))

      expect(sectionOf(rows, 'Pull request')[1]).toBe(words)
      expect(spansOf(textRow(tree, words))[0]?.color).toBe(color)
    }
  })

  test('lists what each reviewer last said, the first four of them', () => {
    const reviews: PullRequest['reviews'] = [
      { author: 'carol', state: 'approved' },
      { author: 'dave', state: 'changes_requested' },
      { author: 'erin', state: 'commented' },
      { author: 'frank', state: 'dismissed' },
      { author: 'gina', state: 'pending' },
    ]
    const { rows, tree } = drawWork(withPr({ reviews }), { width: 80 })

    expect(sectionOf(rows, 'Pull request')[2]).toBe('reviews ✓ carol  ✗ dave  ○ erin  – frank')
    expect(spansOf(textRow(tree, 'reviews ✓ carol  ✗ dave  ○ erin  – frank')).map(one => one.color)).toEqual([
      'inactive',
      'success',
      'error',
      'inactive',
      'inactive',
    ])
    // On a narrow pane the later reviewers leave first.
    expect(sectionOf(drawWork(withPr({ reviews }), { width: 23 }).rows, 'Pull request')[2]).toBe('reviews ✓ carol  ✗ dave')
    expect(sectionOf(drawWork(withPr({ reviews }), { width: 22 }).rows, 'Pull request')[2]).toBe('reviews ✓ carol')
    expect(sectionOf(drawWork(withPr({ reviews: [] })).rows, 'Pull request').some(row => row.startsWith('reviews'))).toBe(false)
  })

  test('says behind what the pull request merges into, not the default branch', () => {
    expect(sectionOf(drawWork(withPr({ merge: 'behind', base: 'release/2.0' })).rows, 'Pull request')).toContain('merge behind release/2.0')
    expect(sectionOf(drawWork(withPr({ merge: 'behind', base: undefined })).rows, 'Pull request')).toContain('merge behind its base')
  })

  test('reads the merge state in words and colors, and says when auto-merge is on', () => {
    const cases: [PullRequest['merge'], string, string][] = [
      ['clean', 'merge ready', 'success'],
      ['behind', 'merge behind main', 'warning'],
      ['dirty', 'merge conflicts', 'error'],
      ['blocked', 'merge blocked', 'warning'],
      ['unstable', 'merge unstable', 'warning'],
      ['draft', 'merge draft', 'inactive'],
      ['unknown', 'merge unknown', 'inactive'],
    ]

    for (const [merge, words, color] of cases) {
      const { rows, tree } = drawWork(withPr({ merge, review: 'approved', base: 'main' }))

      expect(sectionOf(rows, 'Pull request')[2]).toBe(words)
      expect(pieceOf(tree, words, words.slice('merge '.length)).color).toBe(color)
    }
    expect(sectionOf(drawWork(withPr({ review: 'approved', isAutoMerge: true })).rows, 'Pull request')[2]).toBe(
      'merge ready · auto-merge on',
    )
    // A draft already says so in its review row, so the merge row leaves it out.
    expect(sectionOf(drawWork(withPr({ isDraft: true, review: 'draft', merge: 'draft' })).rows, 'Pull request')).toEqual([
      '#5 Tidy up',
      '◌ draft',
      'checks none',
    ])
  })

  test('counts the checks and gives way to narrow panes, the passed count first', () => {
    const outcomes = [
      { name: 'build', outcome: 'passed' as const },
      { name: 'lint', outcome: 'failed' as const },
      { name: 'deploy', outcome: 'pending' as const },
    ]
    const at = (width: number) =>
      sectionOf(drawWork(withPr({ checks: outcomes, review: 'approved' }), { width }).rows, 'Pull request').slice(3, 4)

    expect(at(60)).toEqual(['checks ▰▰▱▱▱ ✗ 1 failed · ● 1 pending · ✓ 1 passed'])
    // The gauge goes first, then the passed count; what failed and what is running stay.
    expect(at(46)).toEqual(['checks ✗ 1 failed · ● 1 pending · ✓ 1 passed'])
    expect(at(40)).toEqual(['checks ✗ 1 failed · ● 1 pending'])
    expect(at(24)).toEqual(['checks ✗ 1 failed'])
  })

  test('names the failing and the pending checks, five each, and only counts the passed and the skipped', () => {
    const list = [
      ...Array.from({ length: 7 }, (_, index) => ({ name: `lint-${index + 1}`, outcome: 'failed' as const })),
      ...Array.from({ length: 6 }, (_, index) => ({ name: `deploy-${index + 1}`, outcome: 'pending' as const })),
      { name: 'build-ok', outcome: 'passed' as const },
      { name: 'docs-ok', outcome: 'passed' as const },
      { name: 'tests-ok', outcome: 'passed' as const },
      { name: 'optional', outcome: 'skipped' as const },
    ]
    const { rows, tree } = drawWork(withPr({ checks: list, review: 'approved' }), { width: 80 })

    expect(sectionOf(rows, 'Pull request').slice(3)).toEqual([
      'checks ▰▱▱▱▱ ✗ 7 failed · ● 6 pending · ✓ 3 passed · – 1 skipped',
      '  ✗ lint-1',
      '  ✗ lint-2',
      '  ✗ lint-3',
      '  ✗ lint-4',
      '  ✗ lint-5',
      '  +2 more failed',
      '  ● deploy-1',
      '  ● deploy-2',
      '  ● deploy-3',
      '  ● deploy-4',
      '  ● deploy-5',
      '  +1 more pending',
    ])
    expect(rows.some(row => row.includes('build-ok') || row.includes('optional'))).toBe(false)
    expect(pieceOf(tree, '  ✗ lint-1', '✗').color).toBe('error')
    expect(pieceOf(tree, '  ● deploy-1', '●').color).toBe('warning')
  })

  test('says so when a pull request has no checks, and shows a green gauge when all passed', () => {
    expect(sectionOf(drawWork(withPr({ review: 'approved' })).rows, 'Pull request')[3]).toBe('checks none')

    const green = drawWork(
      withPr({
        review: 'approved',
        checks: [
          { name: 'a', outcome: 'passed' },
          { name: 'b', outcome: 'passed' },
        ],
      }),
    )

    expect(sectionOf(green.rows, 'Pull request').slice(3)).toEqual(['checks ▰▰▰▰▰ ✓ 2 passed'])
    expect(pieceOf(green.tree, 'checks ▰▰▰▰▰ ✓ 2 passed', '▰').color).toBe('success')
  })

  test('colors the gauge by the worst outcome, and fills it by the share of the checks that ran', () => {
    const gaugeOf = (list: PullRequest['checks']) => {
      const { rows, tree } = drawWork(withPr({ review: 'approved', checks: list }))
      const row = sectionOf(rows, 'Pull request')[3] ?? ''

      return [row, spansOf(textRow(tree, row))[1]?.color]
    }
    const passed = { name: 'build', outcome: 'passed' as const }
    const skipped = { name: 'optional', outcome: 'skipped' as const }

    expect(gaugeOf([passed, { name: 'lint', outcome: 'failed' }])).toEqual(['checks ▰▰▰▱▱ ✗ 1 failed · ✓ 1 passed', 'error'])
    expect(gaugeOf([passed, { name: 'deploy', outcome: 'pending' }])).toEqual(['checks ▰▰▰▱▱ ● 1 pending · ✓ 1 passed', 'warning'])
    // A skipped check did not run, so it counts neither for nor against the share.
    expect(gaugeOf([passed, skipped, skipped, skipped])).toEqual(['checks ▰▰▰▰▰ ✓ 1 passed · – 3 skipped', 'success'])
    expect(gaugeOf([skipped])).toEqual(['checks – 1 skipped', 'inactive'])
  })

  test('draws the latest CI run with its outcome, its age or running clock, and its commit', () => {
    const run = (change: Partial<CiRun>) => drawWork({ ...EMPTY_WORK, ci: { ...CI, ...change } })

    expect(sectionOf(run({}).rows, 'CI')).toEqual(['✓ build · 2m ago · a1b2c3d'])
    expect(sectionOf(run({ outcome: 'failed', at: NOW - 5 * MIN }).rows, 'CI')).toEqual(['✗ build · 5m ago · a1b2c3d'])
    expect(sectionOf(run({ outcome: 'skipped', at: NOW - 3 * HOUR }).rows, 'CI')).toEqual(['– build · 3h ago · a1b2c3d'])
    expect(pieceOf(run({}).tree, '✓ build · 2m ago · a1b2c3d', '✓').color).toBe('success')
    expect(pieceOf(run({ outcome: 'failed' }).tree, '✗ build · 2m ago · a1b2c3d', '✗').color).toBe('error')
    expect(pieceOf(run({}).tree, '✓ build · 2m ago · a1b2c3d', 'build').bold).toBe(true)
  })

  test('draws a CI run that is going with a clock that moves on with the time it is drawn at', () => {
    const running = { isRunning: true, outcome: 'pending' as const, at: NOW - 65 * SEC }

    expect(sectionOf(drawWork({ ...EMPTY_WORK, ci: { ...CI, ...running } }).rows, 'CI')).toEqual(['● build · running 1m05s · a1b2c3d'])
    expect(sectionOf(drawWork({ ...EMPTY_WORK, ci: { ...CI, ...running } }, { nowMs: NOW + 10 * SEC }).rows, 'CI')).toEqual([
      '● build · running 1m15s · a1b2c3d',
    ])
    expect(pieceOf(drawWork({ ...EMPTY_WORK, ci: { ...CI, ...running } }).tree, '● build · running 1m05s · a1b2c3d', '●').color).toBe(
      'warning',
    )
    // A run that is going is drawn as going, whatever its outcome says.
    expect(sectionOf(drawWork({ ...EMPTY_WORK, ci: { ...CI, ...running, outcome: 'failed' } }).rows, 'CI')).toEqual([
      '● build · running 1m05s · a1b2c3d',
    ])
    expect(sectionOf(drawWork(EMPTY_WORK).rows, 'CI')).toEqual(['no CI run for this branch'])
  })

  test('leaves the time out when a CI run has none, rather than drawing a clock of decades', () => {
    const run = (change: Partial<CiRun>) => sectionOf(drawWork({ ...EMPTY_WORK, ci: { ...CI, ...change } }).rows, 'CI')

    expect(run({ at: Number.NaN })).toEqual(['✓ build · a1b2c3d'])
    expect(run({ at: 0 })).toEqual(['✓ build · a1b2c3d'])
    expect(run({ at: 0, isRunning: true, outcome: 'pending' })).toEqual(['● build · running · a1b2c3d'])
  })

  test('puts the sha after the age and drops it first on a narrow pane', () => {
    expect(sectionOf(drawWork(WORK, { width: 20 }).rows, 'CI')).toEqual(['✓ build · 2m ago'])
  })

  test('draws the team board with review and checks marks, author and closing issues, the own pull request in bold', () => {
    const { tree } = drawWork(WORK)
    const mine = '○ ✗ #42 Add the login form · octocat · closes #12'

    expect(spansOf(textRow(tree, mine)).map(one => [one.text, one.color ?? null, one.bold ?? null])).toEqual([
      ['○ ', 'warning', null],
      ['✗ ', 'error', null],
      ['#42', 'cyan', true],
      [' Add the login form', null, true],
      [' · octocat', 'inactive', null],
      [' · closes #12', 'inactive', null],
    ])
    expect(
      spansOf(textRow(tree, '✓ ✓ #40 Bump the toolchain · alice')).map(one => [one.text, one.color ?? null, one.bold ?? null]),
    ).toEqual([
      ['✓ ', 'success', null],
      ['✓ ', 'success', null],
      ['#40', 'cyan', null],
      [' Bump the toolchain', null, null],
      [' · alice', 'inactive', null],
    ])
    expect(pieceOf(tree, '✗ ✗ #41 Cache the lookups for the search… · bob · closes #7', '✗ ').color).toBe('error')
    // A draft has its own mark; a row read without its checks has no check mark at all.
    expect(spansOf(textRow(tree, '◌ #43 Retry policy · carol')).map(one => [one.text, one.color ?? null])).toEqual([
      ['◌ ', 'inactive'],
      ['#43', 'cyan'],
      [' Retry policy', null],
      [' · carol', 'inactive'],
    ])
  })

  test('marks no review needed with a dot, takes the worst of the checks, and bolds nothing when the person has no pull request', () => {
    const board = [
      pr({
        number: 50,
        title: 'No review',
        review: null,
        checks: [
          { name: 'a', outcome: 'skipped' },
          { name: 'b', outcome: 'passed' },
        ],
      }),
      pr({
        number: 51,
        title: 'Running',
        review: 'approved',
        checks: [
          { name: 'a', outcome: 'passed' },
          { name: 'b', outcome: 'pending' },
        ],
      }),
      pr({ number: 52, title: 'All skipped', review: 'pending', checks: [{ name: 'a', outcome: 'skipped' }] }),
    ]
    const { rows, tree } = drawWork({ ...EMPTY_WORK, board, pr: null })

    expect(sectionOf(rows, 'Team board')).toEqual(['· ✓ #50 No review · alice', '✓ ● #51 Running · alice', '○ – #52 All skipped · alice'])
    expect(all(tree, 'Text').some(el => el.props?.bold === true && textOf(el).includes('#5'))).toBe(false)
  })

  test('shows eight pull requests and five unstarted issues, counting the rest, and drops the author and the issue before the title', () => {
    const skipped = [{ name: 'docs', outcome: 'skipped' as const }]
    const board = Array.from({ length: 11 }, (_, index) =>
      pr({ number: 100 + index, title: `Change ${index}`, author: 'alice', checks: skipped }),
    )
    const unstarted = Array.from({ length: 8 }, (_, index) => ({
      number: 200 + index,
      title: `Issue ${index}`,
      url: '',
      assignees: ['bob'],
      labels: [],
      updatedAt: '2026-10-07T08:00:00Z',
    }))
    const { rows } = drawWork({ ...EMPTY_WORK, board, unstarted })
    const shown = sectionOf(rows, 'Team board')

    expect(rows).toContain('Team board 11 open')
    expect(shown.slice(0, 8)).toEqual(Array.from({ length: 8 }, (_, index) => `· – #${100 + index} Change ${index} · alice`))
    expect(shown.slice(8)).toEqual([
      '+3 more',
      'Assigned to you 8',
      '#200 Issue 0 · no PR yet',
      '#201 Issue 1 · no PR yet',
      '#202 Issue 2 · no PR yet',
      '#203 Issue 3 · no PR yet',
      '#204 Issue 4 · no PR yet',
      '+3 more',
    ])
  })

  test('names the repository of an assigned issue or a review request from another repository of the owner', () => {
    const elsewhere = {
      number: 559,
      title: 'Flaky test in the parser',
      url: 'https://github.com/acme/gadgets/issues/559',
      assignees: [],
      labels: [],
      updatedAt: '2026-10-07T08:00:00Z',
      inPr: null,
    }
    const here = { ...elsewhere, number: 8, url: 'https://github.com/acme/widgets/issues/8', title: 'Local one' }
    const queue = [pr({ number: 61, title: 'Shared fix', author: 'dave', url: 'https://github.com/acme/gadgets/pull/61' })]
    const { rows } = drawWork({ ...EMPTY_WORK, unstarted: [elsewhere, here], reviewQueue: queue })

    expect(rows).toContain('gadgets#559 Flaky test in the parser · no PR yet')
    expect(rows).toContain('#8 Local one · no PR yet')
    expect(rows.some(row => row.startsWith('gadgets#61 Shared fix · dave'))).toBe(true)
  })

  test('narrows the board: the title shrinks to twelve cells, then the closing issue and the author leave; the marks and number stay', () => {
    // One skipped check: its mark, a dash, takes the room a check mark takes.
    const checks = [{ name: 'docs', outcome: 'skipped' as const }]
    const board = [pr({ number: 77, title: 'A fairly long pull request title', author: 'octocat', review: 'approved', closes: [3], checks })]
    const at = (width: number) => sectionOf(drawWork({ ...EMPTY_WORK, board }, { width }).rows, 'Team board')

    expect(at(80)).toEqual(['✓ – #77 A fairly long pull request title · octocat · closes #3'])
    expect(at(62)).toEqual(['✓ – #77 A fairly long pull request title · octocat · closes #3'])
    expect(at(60)).toEqual(['✓ – #77 A fairly long pull request ti… · octocat · closes #3'])
    expect(at(50)).toEqual(['✓ – #77 A fairly long pull… · octocat · closes #3'])
    expect(at(41)).toEqual(['✓ – #77 A fairly l… · octocat · closes #3'])
    expect(at(40)).toEqual(['✓ – #77 A fairly long pull re… · octocat'])
    expect(at(29)).toEqual(['✓ – #77 A fairly l… · octocat'])
    expect(at(28)).toEqual(['✓ – #77 A fairly long pull…'])
    expect(at(14)).toEqual(['✓ – #77 A fai…'])
  })

  test('says so when nobody has a pull request open', () => {
    const { rows, tree } = drawWork(EMPTY_WORK)

    expect(rows).toContain('Team board')
    expect(sectionOf(rows, 'Team board')).toEqual(['no open pull requests'])
    expect(pieceOf(tree, 'no open pull requests', 'no open').color).toBe('inactive')
  })

  test('draws the review queue with author and age, five of them, and says when there is nothing to review', () => {
    const queue = Array.from({ length: 7 }, (_, index) =>
      pr({ number: 300 + index, title: `Review ${index}`, author: 'dave', updatedAt: new Date(NOW - (index + 1) * HOUR).toISOString() }),
    )
    const { rows } = drawWork({ ...EMPTY_WORK, reviewQueue: queue })

    expect(rows).toContain('Review queue 7')
    expect(sectionOf(rows, 'Review queue')).toEqual([
      '#300 Review 0 · dave · 1h',
      '#301 Review 1 · dave · 2h',
      '#302 Review 2 · dave · 3h',
      '#303 Review 3 · dave · 4h',
      '#304 Review 4 · dave · 5h',
      '+2 more',
    ])
    expect(sectionOf(drawWork(EMPTY_WORK).rows, 'Review queue')).toEqual(['nothing to review'])
    // An age that cannot be read is left out, not shown as nonsense.
    expect(
      sectionOf(drawWork({ ...EMPTY_WORK, reviewQueue: [pr({ number: 9, title: 'Odd', updatedAt: 'soon' })] }).rows, 'Review queue'),
    ).toEqual(['#9 Odd · alice'])
  })

  test('narrows the review queue: the age leaves first, then the author, the title takes what is left', () => {
    const queue = [pr({ number: 300, title: 'A fairly long review title', author: 'dave', updatedAt: new Date(NOW - HOUR).toISOString() })]
    const at = (width: number) => sectionOf(drawWork({ ...EMPTY_WORK, reviewQueue: queue }, { width }).rows, 'Review queue')

    expect(at(43)).toEqual(['#300 A fairly long review title · dave · 1h'])
    expect(at(35)).toEqual(['#300 A fairly long rev… · dave · 1h'])
    expect(at(28)).toEqual(['#300 A fairly l… · dave · 1h'])
    expect(at(27)).toEqual(['#300 A fairly long… · dave'])
    expect(at(22)).toEqual(['#300 A fairly long re…'])
  })

  test('draws loading… and nothing from GitHub until there is a reading', () => {
    const none = drawWork(null)

    expect(none.rows).toEqual(['loading…'])
    expect(all(none.tree, 'Button')).toEqual([])

    // The lane's first state, before it has read anything: nothing is known yet, so nothing is said to be absent.
    const unread: Work = { ...EMPTY_WORK, repo: null, branch: null, fetchedAt: 0 }

    expect(drawWork(unread).rows).toEqual(['loading…'])
    // With the git side known, the title row shows, and the refresh button is there without an age.
    const partly = drawWork({ ...EMPTY_WORK, fetchedAt: 0 })

    expect(partly.rows).toEqual(['acme/widgets · main ↻', '', 'loading…'])
    expect(buttonAt(partly.tree, 'refresh').props?.label).toBe('↻')
    for (const view of [none.rows, drawWork(unread).rows, partly.rows]) {
      expect(view.some(row => row.includes('no open PR') || row.includes('no ticket') || row.includes('Team board'))).toBe(false)
    }
  })

  test('draws a problem in the warning color with a hint, and none of the GitHub sections', () => {
    const problem = 'gh is not logged in: run gh auth login'
    const { rows, tree, calls, press } = drawWork({ ...WORK, repo: null, problem, canRetry: true })

    expect(rows).toEqual(['feat/12-login-form ↻ 3m', '', problem, 'press ↻ to read GitHub again'])
    expect(textRow(tree, problem).props).toMatchObject({ color: 'warning', wrap: 'wrap' })
    expect(rows.some(row => row === 'Ticket' || row === 'Pull request' || row === 'CI' || row.startsWith('Team board'))).toBe(false)
    // The way out is the same button.
    press('refresh')
    expect(calls.refreshed).toBe(1)
  })
})

describe('work view problems', () => {
  test('gives no refresh hint for a problem a press cannot clear', () => {
    const problem = 'this repository is not on GitHub'
    const { rows } = drawWork({ ...WORK, repo: null, problem, canRetry: false })

    expect(rows).toEqual(['feat/12-login-form ↻ 3m', '', problem])
  })

  test('draws loading… for lists that were not read yet, and counts from GitHub totals once they are', () => {
    expect(sectionOf(drawWork({ ...WORK, board: null, unstarted: null, reviewQueue: null }).rows, 'Team board')).toEqual(['loading…'])
    expect(sectionOf(drawWork({ ...WORK, board: null, unstarted: null, reviewQueue: null }).rows, 'Review queue')).toEqual(['loading…'])

    const totals = { board: 40, reviewQueue: 9, assigned: 12 }
    const { rows } = drawWork({ ...WORK, totals })

    expect(rows).toContain('Team board 40 open')
    expect(rows).toContain('+36 more')
    expect(rows).toContain('Assigned to you 12')
    expect(rows).toContain('Review queue 9')
  })
})

// ---------------------------------------------------------------- the Session tab

type Receipt = NonNullable<SessionView['receipt']>

const receipt = (change: Partial<Receipt>): Receipt => ({ ...SESSION.receipt!, ...change })
const withReceipt = (change: Partial<Receipt>): SessionView => ({ ...EMPTY_SESSION, receipt: receipt(change) })
const spanText = (spans: Span[]) => spans.map(one => [one.text, one.color ?? null])

describe('session view', () => {
  test('draws the six sections in order, an empty line between them', () => {
    const { rows, tree } = drawSession(SESSION, { width: 80 })

    expect(rows).toEqual([
      'Turn',
      '● working 1m05s · 2 agents · 3 edits · 1 error',
      '⟲ 2 compactions',
      '',
      'MCP servers',
      'docs 12 calls · 2 errors · avg 420ms · max 1.8s · last 12s ago',
      '  ▸ fetch  4.2s',
      'files 3 calls · avg 40ms · max 90ms · last 5m ago',
      '  ▸ list  1m05s',
      '',
      'Agents 1 running · 1 finished',
      '1: ▸ explorer · Map the module graph',
      '   steps 12 · ctx 48k · out 3.1k · 1m20s',
      '   ✗ Bash npm test',
      '2: ✓ reviewer · Check the diff · 2m10s',
      '',
      'Permissions 11 checks',
      '■■■■■■■■■■■',
      '■ 1 denied  ■ 1 pending  ■ 1 asked  ■ 8 allowed',
      '■ asked Edit src/a.ts · 10m',
      '■ denied Bash rm -rf build · 10m',
      '',
      'Log',
      ' 3h › you fix the login form',
      ' 5m + main explorer: Map the module graph',
      ' 3m ✎ main src/login.ts',
      ' 1m ✗ explorer npm test failed',
      '40s ⊘ main rm -rf build',
      '30s ✓ reviewer Check the diff',
      '12s ⎇ main commit abc123',
      ' 2s ⟲ main context compacted',
      '',
      'Tools',
      'Read 30 · Bash 12 · docs:search 10',
    ])
    expect(tree).toMatchObject({ type: 'Box', props: { flexDirection: 'column', gap: 1 } })
  })

  test('draws every section with a muted placeholder when the session has done nothing yet', () => {
    const { rows, tree } = drawSession(EMPTY_SESSION)

    expect(rows).toEqual([
      'Turn',
      'no turn yet',
      '',
      'MCP servers',
      'no MCP calls yet',
      '',
      'Agents',
      'no agents yet',
      '',
      'Permissions',
      'no permission checks yet',
      '',
      'Log',
      'nothing logged yet',
      '',
      'Tools',
      'no tool calls yet',
    ])
    for (const words of [
      'no turn yet',
      'no MCP calls yet',
      'no agents yet',
      'no permission checks yet',
      'nothing logged yet',
      'no tool calls yet',
    ]) {
      expect(pieceOf(tree, words, words).color).toBe('inactive')
    }
    expect(all(tree, 'Button')).toEqual([])
  })

  test('titles each section in bold, in the header color, with a muted tail', () => {
    const { tree } = drawSession(SESSION, { width: 80 })

    expect(spansOf(textRow(tree, 'Agents 1 running · 1 finished'))).toEqual([
      { text: 'Agents', color: 'claude', bold: true },
      { text: ' 1 running · 1 finished', color: 'inactive' },
    ])
    expect(spansOf(textRow(tree, 'Turn'))).toEqual([{ text: 'Turn', color: 'claude', bold: true }])
  })

  describe('the turn', () => {
    test('shows a running turn with its clock, which moves on with the time it is drawn at', () => {
      const running = withReceipt({})

      expect(sectionOf(drawSession(running).rows, 'Turn')).toEqual(['● working 1m05s · 2 agents · 3 edits · 1 error'])
      expect(sectionOf(drawSession(running, { nowMs: NOW + 5 * SEC }).rows, 'Turn')).toEqual([
        '● working 1m10s · 2 agents · 3 edits · 1 error',
      ])
      expect(spanText(spansOf(textRow(drawSession(running).tree, '● working 1m05s · 2 agents · 3 edits · 1 error')))).toEqual([
        ['● working 1m05s', 'warning'],
        [' · 2 agents', 'inactive'],
        [' · 3 edits', 'inactive'],
        [' · 1 error', 'error'],
      ])
    })

    test('shows the last turn with its time and cost once it is over', () => {
      const done = withReceipt({ isRunning: false, durationMs: 130_000, errors: 0, costUsd: 0.4213 })
      const row = '✓ 2m10s · $0.42 · 2 agents · 3 edits'

      expect(sectionOf(drawSession(done).rows, 'Turn')).toEqual([row])
      expect(spanText(spansOf(textRow(drawSession(done).tree, row)))).toEqual([
        ['✓ 2m10s', 'success'],
        [' · $0.42', 'inactive'],
        [' · 2 agents', 'inactive'],
        [' · 3 edits', 'inactive'],
      ])
      // The time it is drawn at changes nothing once the turn is over.
      expect(sectionOf(drawSession(done, { nowMs: NOW + HOUR }).rows, 'Turn')).toEqual([row])
    })

    test('leaves out what is zero or unknown, and counts one of a thing in the singular', () => {
      const bare = { agents: 0, edits: 0, errors: 0 }

      expect(sectionOf(drawSession(withReceipt({ ...bare, isRunning: false, durationMs: 130_000 })).rows, 'Turn')).toEqual(['✓ 2m10s'])
      expect(sectionOf(drawSession(withReceipt({ ...bare, isRunning: false, durationMs: null })).rows, 'Turn')).toEqual(['✓ done'])
      expect(sectionOf(drawSession(withReceipt({ ...bare })).rows, 'Turn')).toEqual(['● working 1m05s'])
      expect(sectionOf(drawSession(withReceipt({ ...bare, startedAt: 0 })).rows, 'Turn')).toEqual(['● working'])
      expect(sectionOf(drawSession(withReceipt({ agents: 1, edits: 1, errors: 1 })).rows, 'Turn')).toEqual([
        '● working 1m05s · 1 agent · 1 edit · 1 error',
      ])
      // A running turn has no cost yet, even if one is known.
      expect(sectionOf(drawSession(withReceipt({ costUsd: 1.5 })).rows, 'Turn')[0]).not.toContain('$')
    })

    test('counts the compactions when there are any', () => {
      expect(sectionOf(drawSession({ ...EMPTY_SESSION, compactions: 1 }).rows, 'Turn')).toEqual(['no turn yet', '⟲ 1 compaction'])
      expect(sectionOf(drawSession({ ...EMPTY_SESSION, compactions: 3 }).rows, 'Turn')).toEqual(['no turn yet', '⟲ 3 compactions'])
      expect(sectionOf(drawSession(EMPTY_SESSION).rows, 'Turn')).toEqual(['no turn yet'])
    })

    test('gives way on a narrow pane: the cost, agents and edits leave before the errors', () => {
      const done = withReceipt({ isRunning: false, durationMs: 130_000, costUsd: 0.4213 })
      const at = (width: number) => sectionOf(drawSession(done, { width }).rows, 'Turn')

      expect(at(46)).toEqual(['✓ 2m10s · $0.42 · 2 agents · 3 edits · 1 error'])
      expect(at(45)).toEqual(['✓ 2m10s · 2 agents · 3 edits · 1 error'])
      expect(at(38)).toEqual(['✓ 2m10s · 2 agents · 3 edits · 1 error'])
      expect(at(37)).toEqual(['✓ 2m10s · 3 edits · 1 error'])
      expect(at(26)).toEqual(['✓ 2m10s · 1 error'])
      expect(at(16)).toEqual(['✓ 2m10s'])
    })
  })

  describe('the MCP servers', () => {
    test('draws a row per server: calls, errors in the error color, average and slowest call, and when it last answered', () => {
      const { rows, tree } = drawSession({ ...EMPTY_SESSION, mcp: SESSION.mcp }, { width: 80 })

      expect(sectionOf(rows, 'MCP servers')).toEqual([
        'docs 12 calls · 2 errors · avg 420ms · max 1.8s · last 12s ago',
        '  ▸ fetch  4.2s',
        'files 3 calls · avg 40ms · max 90ms · last 5m ago',
        '  ▸ list  1m05s',
      ])
      expect(spanText(spansOf(textRow(tree, 'docs 12 calls · 2 errors · avg 420ms · max 1.8s · last 12s ago')))).toEqual([
        ['docs', null],
        [' 12 calls', 'inactive'],
        [' · 2 errors', 'error'],
        [' · avg 420ms', 'inactive'],
        [' · max 1.8s', 'inactive'],
        [' · last 12s ago', 'inactive'],
      ])
      expect(spansOf(textRow(tree, 'docs 12 calls · 2 errors · avg 420ms · max 1.8s · last 12s ago'))[0]).toMatchObject({ bold: true })
    })

    test('leaves out when a server last answered if that time is not known', () => {
      const unknown = { ...EMPTY_SESSION, mcp: [server({ lastAt: 0 }), server({ server: 'files', lastAt: Number.NaN })] }

      expect(sectionOf(drawSession(unknown, { width: 80 }).rows, 'MCP servers')).toEqual([
        'docs 12 calls · 2 errors · avg 420ms · max 1.8s',
        'files 12 calls · 2 errors · avg 420ms · max 1.8s',
      ])
    })

    test('counts one call in the singular, and shows no average for a server that has not answered yet', () => {
      const one = server({ server: 'files', calls: 1, errors: 1, totalMs: 40, maxMs: 40, lastAt: NOW - 3 * HOUR })
      const pending = server({
        server: 'slow',
        calls: 0,
        errors: 0,
        totalMs: 0,
        maxMs: 0,
        lastAt: null,
        inFlight: [{ id: 'x', tool: 'run', startedAt: NOW - SEC }],
      })

      expect(sectionOf(drawSession({ ...EMPTY_SESSION, mcp: [one, pending] }, { width: 80 }).rows, 'MCP servers')).toEqual([
        'files 1 call · 1 error · avg 40ms · max 40ms · last 3h ago',
        'slow 0 calls',
        '  ▸ run  1.0s',
      ])
    })

    test('draws a call in flight with an elapsed time that moves on, and in the error color once it runs past a minute', () => {
      const flight = (ms: number) => ({
        ...EMPTY_SESSION,
        mcp: [server({ inFlight: [{ id: 'c', tool: 'mcp__docs__fetch', startedAt: NOW - ms }] })],
      })
      const rowOf = (ms: number, nowMs = NOW) => {
        const { rows, tree } = drawSession(flight(ms), { width: 80, nowMs })
        const row = sectionOf(rows, 'MCP servers')[1] ?? ''

        return { row, color: pieceOf(tree, row, '▸').color }
      }

      expect(rowOf(4200)).toEqual({ row: '  ▸ fetch  4.2s', color: 'warning' })
      expect(rowOf(4200, NOW + 3 * SEC)).toEqual({ row: '  ▸ fetch  7.2s', color: 'warning' })
      expect(rowOf(59_000)).toEqual({ row: '  ▸ fetch  59s', color: 'warning' })
      expect(rowOf(60_000)).toEqual({ row: '  ▸ fetch  1m00s', color: 'warning' })
      expect(rowOf(60_001)).toEqual({ row: '  ▸ fetch  1m00s', color: 'error' })
      expect(rowOf(125_000)).toEqual({ row: '  ▸ fetch  2m05s', color: 'error' })
      // The whole row is drawn in that color, the tool and the time too.
      const stuck = drawSession(flight(125_000), { width: 80 })

      expect(spansOf(textRow(stuck.tree, '  ▸ fetch  2m05s')).map(one => one.color)).toEqual(['error', 'error', 'error'])
    })

    test('cuts the tool name, not the time, of a call in flight on a narrow pane', () => {
      const long = server({ lastAt: null, inFlight: [{ id: 'c', tool: 'mcp__docs__a_very_long_tool_name', startedAt: NOW - 4200 }] })
      const row = sectionOf(drawSession({ ...EMPTY_SESSION, mcp: [long] }, { width: 24 }).rows, 'MCP servers')[1]

      expect(row).toBe('  ▸ a_very_long_t…  4.2s')
      expect(cells(row ?? '')).toBe(24)
      // Below the tool's minimum it is still the tool that gives way, and the time stays.
      expect(sectionOf(drawSession({ ...EMPTY_SESSION, mcp: [long] }, { width: 14 }).rows, 'MCP servers')[1]).toBe('  ▸ a_v…  4.2s')
    })

    test('lists the calls of a server oldest first, three of them, and counts the rest', () => {
      const inFlight = [5, 1, 4, 2, 3].map(seconds => ({ id: `c${seconds}`, tool: `tool${seconds}`, startedAt: NOW - seconds * SEC }))
      const { rows } = drawSession({ ...EMPTY_SESSION, mcp: [server({ lastAt: null, inFlight })] }, { width: 80 })

      expect(sectionOf(rows, 'MCP servers')).toEqual([
        'docs 12 calls · 2 errors · avg 420ms · max 1.8s',
        '  ▸ tool5  5.0s',
        '  ▸ tool4  4.0s',
        '  ▸ tool3  3.0s',
        '  +2 more running',
      ])
    })

    test('shows eight servers and counts the rest', () => {
      const many = Array.from({ length: 10 }, (_, index) =>
        server({ server: `srv${index}`, calls: 1, errors: 0, totalMs: 10, maxMs: 10, lastAt: null }),
      )
      const rows = sectionOf(drawSession({ ...EMPTY_SESSION, mcp: many }, { width: 80 }).rows, 'MCP servers')

      expect(rows).toHaveLength(9)
      expect(rows[0]).toBe('srv0 1 call · avg 10ms · max 10ms')
      expect(rows[7]).toBe('srv7 1 call · avg 10ms · max 10ms')
      expect(rows[8]).toBe('+2 more')
    })

    test('gives way on a narrow pane: the slowest call leaves first, then the average, then when it last answered, then the errors', () => {
      const only = { ...EMPTY_SESSION, mcp: [SESSION.mcp[0]!] }
      const at = (width: number) => sectionOf(drawSession(only, { width }).rows, 'MCP servers')[0]

      expect(at(62)).toBe('docs 12 calls · 2 errors · avg 420ms · max 1.8s · last 12s ago')
      expect(at(61)).toBe('docs 12 calls · 2 errors · avg 420ms · last 12s ago')
      expect(at(51)).toBe('docs 12 calls · 2 errors · avg 420ms · last 12s ago')
      expect(at(50)).toBe('docs 12 calls · 2 errors · last 12s ago')
      expect(at(39)).toBe('docs 12 calls · 2 errors · last 12s ago')
      expect(at(38)).toBe('docs 12 calls · 2 errors')
      expect(at(24)).toBe('docs 12 calls · 2 errors')
      // The name and the calls are the last to stay.
      expect(at(23)).toBe('docs 12 calls')
      expect(at(13)).toBe('docs 12 calls')
    })
  })

  describe('the agents', () => {
    const cards = [
      agent({ id: 'r1', type: 'explorer', description: 'Map the graph', startedAt: NOW - 100 * SEC }),
      agent({
        id: 'r2',
        type: 'writer',
        description: 'Draft the notes',
        startedAt: NOW - 50 * SEC,
        steps: 0,
        contextTokens: 0,
        outputTokens: 0,
      }),
      agent({
        id: 'd1',
        type: 'reviewer',
        description: 'Check the diff',
        status: 'done',
        startedAt: NOW - 160 * SEC,
        endedAt: NOW - 10 * SEC,
      }),
      // Started after the reviewer and ended before it: the finished cards are ordered by when they ended.
      agent({
        id: 'd2',
        type: 'tester',
        description: 'Run the suite',
        status: 'done',
        startedAt: NOW - 100 * SEC,
        endedAt: NOW - 60 * SEC,
      }),
      agent({
        id: 's1',
        type: 'linter',
        description: 'Lint the tree',
        status: 'stopped',
        startedAt: NOW - 220 * SEC,
        endedAt: NOW - 20 * SEC,
      }),
      agent({ id: 'f1', type: 'builder', description: 'Build it', status: 'failed', startedAt: NOW - 17 * SEC, endedAt: NOW - 5 * SEC }),
    ]

    test('puts running cards first, then the finished ones newest first, each a button keyed and hotkeyed by its place', () => {
      const { tree, rows } = drawSession({ ...EMPTY_SESSION, agents: cards }, { width: 80 })

      expect(rows).toContain('Agents 2 running · 4 finished')
      expect(all(tree, 'Button').map(button => [button.props?.key, button.props?.hotkey, button.props?.label])).toEqual([
        ['agent-1', '1', '▸ explorer · Map the graph'],
        ['agent-2', '2', '▸ writer · Draft the notes'],
        ['agent-3', '3', '✗ builder · Build it · 12s'],
        ['agent-4', '4', '✓ reviewer · Check the diff · 2m30s'],
        ['agent-5', '5', '■ linter · Lint the tree · 3m20s'],
        ['agent-6', '6', '✓ tester · Run the suite · 40s'],
      ])
      for (const button of all(tree, 'Button')) {
        expect(button.props).toMatchObject({ plain: true })
      }
      // The finished ones are drawn dim at rest; the running ones are not.
      expect(all(tree, 'Button').map(button => button.props?.dimColor ?? false)).toEqual([false, false, true, true, true, true])
    })

    test('shows a running agent as a card: figures, last tool, and a clock that moves on', () => {
      const withTools = agent({
        tools: [
          { tool: 'Read', text: 'a.ts', isError: false },
          { tool: 'Bash', text: 'npm test', isError: true },
        ],
      })
      const { rows, tree } = drawSession({ ...EMPTY_SESSION, agents: [withTools] }, { width: 60 })

      expect(sectionOf(rows, 'Agents')).toEqual([
        '1: ▸ explorer · Map the module graph',
        '   steps 12 · ctx 48k · out 3.1k · 1m20s',
        '   ✗ Bash npm test',
      ])
      expect(pieceOf(tree, '   ✗ Bash npm test', '✗').color).toBe('error')
      expect(sectionOf(drawSession({ ...EMPTY_SESSION, agents: [withTools] }, { nowMs: NOW + 40 * SEC }).rows, 'Agents')[1]).toBe(
        '   steps 12 · ctx 48k · out 3.1k · 2m00s',
      )
      // A last tool that did not fail is muted.
      const fine = agent({ tools: [{ tool: 'Read', text: 'a.ts', isError: false }] })
      const quiet = drawSession({ ...EMPTY_SESSION, agents: [fine] })

      expect(spanText(spansOf(textRow(quiet.tree, '   · Read a.ts')))).toEqual([
        ['   ', null],
        ['· ', 'inactive'],
        ['Read', null],
        [' a.ts', 'inactive'],
      ])
    })

    test('says a running agent is starting until it has taken a step, and leaves the clock out when its start is unknown', () => {
      const fresh = agent({ steps: 0, contextTokens: 0, outputTokens: 0, startedAt: NOW - 3 * SEC })
      const unknown = agent({ startedAt: 0 })

      expect(sectionOf(drawSession({ ...EMPTY_SESSION, agents: [fresh] }).rows, 'Agents')[1]).toBe('   starting · 3s')
      expect(sectionOf(drawSession({ ...EMPTY_SESSION, agents: [unknown] }).rows, 'Agents')[1]).toBe('   steps 12 · ctx 48k · out 3.1k')
    })

    test('draws a finished agent in one row, with a mark for how it ended and how long it took', () => {
      const ended = (change: Partial<AgentCard>) =>
        sectionOf(drawSession({ ...EMPTY_SESSION, agents: [agent({ status: 'done', endedAt: NOW - 10 * SEC, ...change })] }).rows, 'Agents')

      expect(ended({})).toEqual(['1: ✓ explorer · Map the module graph · 1m10s'])
      expect(ended({ status: 'stopped' })).toEqual(['1: ■ explorer · Map the module graph · 1m10s'])
      expect(ended({ status: 'failed' })).toEqual(['1: ✗ explorer · Map the module graph · 1m10s'])
      expect(ended({ description: '' })).toEqual(['1: ✓ explorer · 1m10s'])
      expect(ended({ type: '' })).toEqual(['1: ✓ Map the module graph · 1m10s'])
      expect(ended({ type: '', description: '' })).toEqual(['1: ✓ agent · 1m10s'])
      expect(ended({ endedAt: null })).toEqual(['1: ✓ explorer · Map the module graph'])
    })

    test('cuts the description, not the time, when the pane is narrow', () => {
      const done = agent({ status: 'done', endedAt: NOW - 10 * SEC, description: 'Map every module in the whole dependency graph' })
      const at = (width: number) => sectionOf(drawSession({ ...EMPTY_SESSION, agents: [done] }, { width }).rows, 'Agents')[0]

      expect(at(80)).toBe('1: ✓ explorer · Map every module in the whole dependency graph · 1m10s')
      expect(at(40)).toBe('1: ✓ explorer · Map every modul… · 1m10s')
      // Even when its minimum no longer fits, it is the description that is cut, not the time.
      expect(at(28)).toBe('1: ✓ explorer · Map… · 1m10s')
    })

    test('shows six cards and counts the rest', () => {
      const many = Array.from({ length: 9 }, (_, index) =>
        agent({ id: `m${index}`, description: `Job ${index}`, startedAt: NOW - (index + 1) * SEC }),
      )
      const { rows, tree } = drawSession({ ...EMPTY_SESSION, agents: many })

      expect(all(tree, 'Button')).toHaveLength(6)
      expect(rows).toContain('Agents 9 running')
      expect(sectionOf(rows, 'Agents').at(-1)).toBe('+3 more')
      expect(all(tree, 'Button').map(button => button.props?.key)).toEqual([
        'agent-1',
        'agent-2',
        'agent-3',
        'agent-4',
        'agent-5',
        'agent-6',
      ])
    })

    test('opens the card that is pressed through onExpand, and a second press closes it', () => {
      const closed = drawSession({ ...EMPTY_SESSION, agents: cards })

      closed.press('agent-2')
      closed.press('agent-5')
      expect(closed.calls.expanded).toEqual(['r2', 's1'])

      // With that card open, the same button asks for it to close.
      const open = drawSession({ ...EMPTY_SESSION, agents: cards }, { expanded: 'r2' })

      open.press('agent-2')
      open.press('agent-1')
      expect(open.calls.expanded).toEqual([null, 'r1'])
    })

    test('shows the last three tools and the start of the answer of the open card, and no other', () => {
      const tools = ['a', 'b', 'c', 'd', 'e'].map(name => ({ tool: 'Read', text: `${name}.ts`, isError: name === 'c' }))
      const list = [
        agent({ id: 'r1', tools, answer: '' }),
        agent({
          id: 'd1',
          type: 'reviewer',
          description: 'Check',
          status: 'done',
          endedAt: NOW - 10 * SEC,
          tools,
          answer: 'All clear apart from one nit.',
        }),
      ]
      const open = drawSession({ ...EMPTY_SESSION, agents: list }, { expanded: 'r1' })

      // A running card that is open lists its tools in place of its last tool, and has no answer yet.
      expect(sectionOf(open.rows, 'Agents')).toEqual([
        '1: ▸ explorer · Map the module graph',
        '   steps 12 · ctx 48k · out 3.1k · 1m20s',
        '   ✗ Read c.ts',
        '   · Read d.ts',
        '   · Read e.ts',
        '2: ✓ reviewer · Check · 1m10s',
      ])

      // A finished card that is open adds its tools and its answer; the running one shows its last tool again.
      const done = drawSession({ ...EMPTY_SESSION, agents: list }, { expanded: 'd1' })

      expect(sectionOf(done.rows, 'Agents')).toEqual([
        '1: ▸ explorer · Map the module graph',
        '   steps 12 · ctx 48k · out 3.1k · 1m20s',
        '   · Read e.ts',
        '2: ✓ reviewer · Check · 1m10s',
        '   ✗ Read c.ts',
        '   · Read d.ts',
        '   · Read e.ts',
        '» All clear apart from one nit.',
      ])
      // The answer wraps under the card's label, not at the edge of the pane.
      const answer = textRow(done.tree, '» All clear apart from one nit.')

      expect(answer.props).toMatchObject({ wrap: 'wrap', color: 'inactive' })
      expect(all(done.tree, 'Box').some(box => box.props?.paddingLeft === 3 && box.children?.includes(answer))).toBe(true)
    })

    test('says an open card has made no tool call yet, and cuts a long answer to three rows of the pane', () => {
      const quiet = drawSession({ ...EMPTY_SESSION, agents: [agent({ id: 'r1', tools: [] })] }, { expanded: 'r1' })

      expect(sectionOf(quiet.rows, 'Agents').at(-1)).toBe('   no tool calls yet')

      const long = agent({ id: 'd1', status: 'done', endedAt: NOW - SEC, answer: 'word '.repeat(100) })
      const { rows } = drawSession({ ...EMPTY_SESSION, agents: [long] }, { expanded: 'd1', width: 40 })
      const answer = sectionOf(rows, 'Agents').at(-1) ?? ''

      expect(answer.startsWith('» word word word')).toBe(true)
      expect(answer.endsWith('…')).toBe(true)
      expect(answer.length).toBeLessThanOrEqual(3 * (40 - 3))
    })

    test('draws the same rows whether an agent that is not shown, or none, is open', () => {
      const closed = drawSession({ ...EMPTY_SESSION, agents: cards }).rows

      expect(drawSession({ ...EMPTY_SESSION, agents: cards }, { expanded: 'nobody' }).rows).toEqual(closed)
      expect(drawSession({ ...EMPTY_SESSION, agents: cards }, { expanded: null }).rows).toEqual(closed)
    })

    test('draws a finished agent without a duration when its start is not known', () => {
      const done = agent({ status: 'done', startedAt: 0, endedAt: NOW - 10 * SEC })

      expect(sectionOf(drawSession({ ...EMPTY_SESSION, agents: [done] }).rows, 'Agents')).toEqual(['1: ✓ explorer · Map the module graph'])
    })

    test('says there are no agents yet', () => {
      expect(sectionOf(drawSession(EMPTY_SESSION).rows, 'Agents')).toEqual(['no agents yet'])
    })
  })

  describe('the permission checks', () => {
    test('draws one cell per check, colored by verdict, the ones inside a subagent dim', () => {
      const gate = [
        ...checks(2, 'rule'),
        check('a', 'asked'),
        check('p', 'pending'),
        check('d', 'denied'),
        check('s', 'rule', { inSubagent: true }),
      ]
      const { tree } = drawSession({ ...EMPTY_SESSION, gate })

      expect(spansOf(textRow(tree, '■■■■■■'))).toEqual([
        { text: '■■', color: 'success' },
        { text: '■', color: 'suggestion' },
        { text: '■', color: 'warning' },
        { text: '■', color: 'error' },
        { text: '■', color: 'success', dim: true },
      ])
    })

    test('splits a run where only the dimness changes', () => {
      const gate = [check('a', 'rule'), check('b', 'rule', { inSubagent: true }), check('c', 'rule')]

      expect(spansOf(textRow(drawSession({ ...EMPTY_SESSION, gate }).tree, '■■■'))).toEqual([
        { text: '■', color: 'success' },
        { text: '■', color: 'success', dim: true },
        { text: '■', color: 'success' },
      ])
    })

    test('draws the last forty checks only', () => {
      const gate = [...checks(30, 'denied'), ...checks(60, 'rule')]
      const { rows } = drawSession({ ...EMPTY_SESSION, gate }, { width: 80 })

      expect(sectionOf(rows, 'Permissions')[0]).toBe('■'.repeat(40))
      expect(rows).toContain('Permissions 90 checks')
      // Counts are over every check, the strip over the last forty.
      expect(sectionOf(rows, 'Permissions')[1]).toBe('■ 30 denied  ■ 60 allowed')
    })

    test('keeps the strip inside a narrow pane', () => {
      const { rows } = drawSession({ ...EMPTY_SESSION, gate: checks(60, 'rule') }, { width: 24 })

      expect(sectionOf(rows, 'Permissions')[0]).toBe('■'.repeat(24))
    })

    test('counts each verdict, worst first, and drops the allowed count before the others on a narrow pane', () => {
      const gate = [...checks(8, 'rule'), check('a', 'asked'), check('p', 'pending'), check('d', 'denied')]
      const at = (width: number) => sectionOf(drawSession({ ...EMPTY_SESSION, gate }, { width }).rows, 'Permissions')[1]

      expect(at(80)).toBe('■ 1 denied  ■ 1 pending  ■ 1 asked  ■ 8 allowed')
      expect(at(40)).toBe('■ 1 denied  ■ 1 pending  ■ 1 asked')
      expect(at(30)).toBe('■ 1 denied  ■ 1 pending')
      expect(at(20)).toBe('■ 1 denied')
      expect(sectionOf(drawSession({ ...EMPTY_SESSION, gate: checks(3, 'rule') }).rows, 'Permissions')[1]).toBe('■ 3 allowed')

      const { tree } = drawSession({ ...EMPTY_SESSION, gate }, { width: 80 })

      expect(spansOf(textRow(tree, '■ 1 denied  ■ 1 pending  ■ 1 asked  ■ 8 allowed')).map(one => one.color)).toEqual([
        'error',
        'warning',
        'suggestion',
        'success',
      ])
    })

    test('details the last three denied or asked checks, oldest first, with how long ago', () => {
      const gate = [
        check('d0', 'denied', { tool: 'Bash', detail: 'rm -rf /', at: NOW - 5 * HOUR }),
        check('a1', 'asked', { tool: 'Edit', detail: 'src/a.ts', at: NOW - 40 * MIN }),
        check('r1', 'rule', { tool: 'Read', detail: 'src/b.ts', at: NOW - 30 * MIN }),
        check('d1', 'denied', { tool: 'mcp__docs__delete', detail: 'page 12', at: NOW - 3 * MIN }),
        check('p1', 'pending', { tool: 'Write', detail: 'out.txt', at: NOW - 2 * MIN }),
        check('a2', 'asked', { tool: 'Bash', detail: '', at: NOW - 20 * SEC }),
      ]
      const { rows, tree } = drawSession({ ...EMPTY_SESSION, gate }, { width: 80 })

      expect(sectionOf(rows, 'Permissions').slice(2)).toEqual([
        '■ asked Edit src/a.ts · 40m',
        '■ denied docs:delete page 12 · 3m',
        '■ asked Bash · 20s',
      ])
      expect(pieceOf(tree, '■ denied docs:delete page 12 · 3m', '■ denied').color).toBe('error')
      expect(pieceOf(tree, '■ asked Edit src/a.ts · 40m', '■ asked').color).toBe('suggestion')
      expect(pieceOf(tree, '■ asked Edit src/a.ts · 40m', 'src/a.ts').color).toBe('inactive')
    })

    test('leaves out how long ago a denied check was when its time is not known', () => {
      const gate = [check('d', 'denied', { detail: 'rm -rf build', at: Number.NaN })]

      expect(sectionOf(drawSession({ ...EMPTY_SESSION, gate }, { width: 80 }).rows, 'Permissions').slice(2)).toEqual([
        '■ denied Bash rm -rf build',
      ])
    })

    test('has no details when nothing was denied or asked, and says so when there are no checks', () => {
      expect(sectionOf(drawSession({ ...EMPTY_SESSION, gate: checks(3, 'rule') }).rows, 'Permissions')).toHaveLength(2)
      expect(sectionOf(drawSession(EMPTY_SESSION).rows, 'Permissions')).toEqual(['no permission checks yet'])
      expect(drawSession({ ...EMPTY_SESSION, gate: checks(1, 'rule') }).rows).toContain('Permissions 1 check')
    })
  })

  describe('the log', () => {
    test('draws each kind with its glyph and color, who did it, and how long ago, errors in the error color', () => {
      const kinds: [LogEntry['kind'], string, string][] = [
        ['prompt', '›', 'claude'],
        ['spawn', '+', 'suggestion'],
        ['done', '✓', 'success'],
        ['edit', '✎', 'blue'],
        ['error', '✗', 'error'],
        ['denied', '⊘', 'error'],
        ['compact', '⟲', 'warning'],
        ['git', '⎇', 'magenta'],
      ]
      const log = kinds.map(([kind], index) => entry(kind, NOW - (index + 1) * 20 * SEC, 'main', `a ${kind}`))
      const { rows, tree } = drawSession({ ...EMPTY_SESSION, log })

      expect(sectionOf(rows, 'Log')).toEqual([
        '20s › main a prompt',
        '40s + main a spawn',
        ' 1m ✓ main a done',
        ' 1m ✎ main a edit',
        ' 1m ✗ main a error',
        ' 2m ⊘ main a denied',
        ' 2m ⟲ main a compact',
        ' 2m ⎇ main a git',
      ])
      for (const [kind, glyph, color] of kinds) {
        expect(pieceOf(tree, rows.find(row => row.endsWith(`a ${kind}`)) ?? '', glyph).color).toBe(color)
      }
    })

    test('colors the text of an error entry and no other', () => {
      const log = [entry('error', NOW - 5 * SEC, 'explorer', 'npm test failed'), entry('edit', NOW - 4 * SEC, 'main', 'src/a.ts')]
      const { tree } = drawSession({ ...EMPTY_SESSION, log })

      expect(spanText(spansOf(textRow(tree, ' 5s ✗ explorer npm test failed')))).toEqual([
        [' 5s ', 'inactive'],
        ['✗ ', 'error'],
        ['explorer ', null],
        ['npm test failed', 'error'],
      ])
      expect(spanText(spansOf(textRow(tree, ' 4s ✎ main src/a.ts'))).at(-1)).toEqual(['src/a.ts', null])
      // Who did it is in bold.
      expect(spansOf(textRow(tree, ' 5s ✗ explorer npm test failed'))[2]).toEqual({ text: 'explorer ', bold: true })
    })

    test('shows the last ten entries, oldest first, or as many as it is asked for', () => {
      const log = Array.from({ length: 14 }, (_, index) => entry('edit', NOW - (14 - index) * SEC, 'main', `file ${index}.ts`))
      const rowsAt = (logRows?: number) =>
        sectionOf(drawSession({ ...EMPTY_SESSION, log }, logRows === undefined ? {} : { logRows }).rows, 'Log')

      expect(rowsAt()).toHaveLength(10)
      expect(rowsAt()[0]).toBe('10s ✎ main file 4.ts')
      expect(rowsAt()[9]).toBe(' 1s ✎ main file 13.ts')
      expect(rowsAt(3)).toEqual([' 3s ✎ main file 11.ts', ' 2s ✎ main file 12.ts', ' 1s ✎ main file 13.ts'])
      expect(rowsAt(0)).toEqual([' 1s ✎ main file 13.ts'])
      expect(rowsAt(50)).toHaveLength(14)
    })

    test('counts ages in seconds, minutes, hours and days, and cuts a long name and a long text', () => {
      const log = [
        entry('prompt', NOW - 4 * 24 * HOUR, 'you', 'older'),
        entry('prompt', NOW - 2 * HOUR, 'you', 'old'),
        entry('prompt', NOW - 3 * MIN, 'a-very-long-agent-type-name', 'x'.repeat(100)),
      ]
      const rows = sectionOf(drawSession({ ...EMPTY_SESSION, log }, { width: 40 }).rows, 'Log')

      expect(rows).toEqual([' 4d › you older', ' 2h › you old', ` 3m › a-very-long-a… ${'x'.repeat(18)}…`])
      expect(cells(rows[2] ?? '')).toBe(40)
    })

    test('says nothing has been logged yet', () => {
      expect(sectionOf(drawSession(EMPTY_SESSION).rows, 'Log')).toEqual(['nothing logged yet'])
    })
  })

  describe('the tools', () => {
    test('lists the most used first, an MCP tool with its server, in muted wrapped text', () => {
      const { rows, tree } = drawSession({ ...EMPTY_SESSION, tools: SESSION.tools })

      expect(sectionOf(rows, 'Tools')).toEqual(['Read 30 · Bash 12 · docs:search 10'])
      expect(textRow(tree, 'Read 30 · Bash 12 · docs:search 10').props).toMatchObject({ wrap: 'wrap', color: 'inactive' })
    })

    test('keeps the order of tools that were used as often, and lists twelve at most', () => {
      const many = Array.from({ length: 15 }, (_, index) => ({ name: `Tool${index}`, count: index < 3 ? 9 : 1 }))
      const [row] = sectionOf(drawSession({ ...EMPTY_SESSION, tools: many }, { width: 80 }).rows, 'Tools')

      expect(row).toBe(
        'Tool0 9 · Tool1 9 · Tool2 9 · Tool3 1 · Tool4 1 · Tool5 1 · Tool6 1 · Tool7 1 · Tool8 1 · Tool9 1 · Tool10 1 · Tool11 1',
      )
    })

    test('says no tool was called yet', () => {
      expect(sectionOf(drawSession(EMPTY_SESSION).rows, 'Tools')).toEqual(['no tool calls yet'])
    })
  })

  test('draws narrow, the way the sections give way together', () => {
    const { rows } = drawSession(SESSION, { width: 40 })

    expect(sectionOf(rows, 'Turn')).toEqual(['● working 1m05s · 3 edits · 1 error', '⟲ 2 compactions'])
    expect(sectionOf(rows, 'MCP servers')).toEqual([
      'docs 12 calls · 2 errors · last 12s ago',
      '  ▸ fetch  4.2s',
      'files 3 calls · avg 40ms · last 5m ago',
      '  ▸ list  1m05s',
    ])
    expect(sectionOf(rows, 'Permissions')[1]).toBe('■ 1 denied  ■ 1 pending  ■ 1 asked')
    expect(sectionOf(rows, 'Log')[1]).toBe(' 5m + main explorer: Map the module gra…')
  })
})

// ---------------------------------------------------------------- what a surface would refuse

const HOSTILE_WORK: Work = {
  repo: dirty('acme/widgets'),
  branch: dirty('feat/x'),
  tickets: [ticket({ title: dirty('Ticket title'), state: dirty('open'), labels: [dirty('bug')], assignees: [dirty('alice')] })],
  pr: pr({
    number: 42,
    title: dirty('PR title'),
    url: 'https://github.com/acme/widgets/pull/42',
    author: dirty('octocat'),
    review: 'pending',
    reviewers: [dirty('alice')],
    reviews: [{ author: dirty('carol'), state: 'approved' }],
    checks: [
      { name: dirty('lint'), outcome: 'failed' },
      { name: dirty('deploy'), outcome: 'pending' },
    ],
    merge: 'behind',
    isAutoMerge: true,
    closes: [12],
  }),
  ci: { ...CI, workflow: dirty('build'), sha: dirty('abc1234') },
  board: [pr({ number: 40, title: dirty('Board title'), author: dirty('bob') })],
  unstarted: [
    { number: 7, title: dirty('Issue title'), url: '', assignees: [dirty('dave')], labels: [], updatedAt: '2026-10-07T08:00:00Z' },
  ],
  reviewQueue: [pr({ number: 38, title: dirty('Queue title'), author: dirty('erin') })],
  fetchedAt: NOW - MIN,
  problem: null,
  totals: null,
  canRetry: false,
}

const HOSTILE_SESSION: SessionView = {
  receipt: SESSION.receipt,
  compactions: 1,
  mcp: [server({ server: dirty('docs'), inFlight: [{ id: 'c', tool: dirty('mcp__docs__fetch'), startedAt: NOW - 3 * SEC }] })],
  agents: [
    agent({
      id: 'a1',
      type: dirty('explorer'),
      description: dirty('Map it'),
      tools: [{ tool: dirty('Bash'), text: dirty('npm test'), isError: true }],
      answer: dirty('Done and dusted'),
    }),
  ],
  gate: [check('d', 'denied', { tool: dirty('Bash'), detail: dirty('rm -rf build') })],
  log: [entry('error', NOW - 5 * SEC, dirty('explorer'), dirty('npm test failed'))],
  tools: [{ name: dirty('mcp__docs__search'), count: 3 }],
}

/** Wide characters and emoji where the layout counts cells. */
const WIDE_WORK: Work = {
  ...WORK,
  repo: '日本語/ウィジェット',
  branch: '機能/ログイン画面',
  tickets: [ticket({ title: 'ログイン画面を追加する 🎉✨' })],
  pr: { ...MINE, title: 'ログインフォームを追加 🚀' },
  board: [pr({ number: 40, title: '依存関係を更新する 🛠️ そして文書を直す', author: 'アリス', closes: [7] })],
}

const DRAWINGS: [string, (width: number) => unknown][] = [
  ['work', width => drawWork(WORK, { width }).tree],
  ['work with nothing in it', width => drawWork(EMPTY_WORK, { width }).tree],
  ['work with wide characters', width => drawWork(WIDE_WORK, { width }).tree],
  ['work with hostile text', width => drawWork(HOSTILE_WORK, { width }).tree],
  ['work with a hostile problem', width => drawWork({ ...HOSTILE_WORK, problem: dirty('gh is gone') }, { width }).tree],
  ['work loading', width => drawWork(null, { width }).tree],
  ['session', width => drawSession(SESSION, { width }).tree],
  ['session with a card open', width => drawSession(SESSION, { width, expanded: 'a2' }).tree],
  ['session with nothing in it', width => drawSession(EMPTY_SESSION, { width }).tree],
  ['session with hostile text', width => drawSession(HOSTILE_SESSION, { width, expanded: 'a1' }).tree],
]

// The props the d.ts lists for each element: a tree with any other prop is refused whole.
const ALLOWED: Record<string, string[]> = {
  Box: [
    'key hover position top left right bottom flexDirection flexGrow flexShrink flexWrap alignItems alignSelf justifyContent',
    'gap columnGap rowGap width height minWidth minHeight margin marginX marginY marginTop marginBottom marginLeft marginRight',
    'padding paddingX paddingY paddingTop paddingBottom paddingLeft paddingRight borderStyle borderColor borderDimColor',
    'backgroundColor overflow display',
  ]
    .join(' ')
    .split(' '),
  Text: ['hover', 'color', 'backgroundColor', 'dimColor', 'bold', 'italic', 'underline', 'strikethrough', 'inverse', 'wrap'],
  Button: ['key', 'label', 'hotkey', 'action', 'plain', 'dimColor', 'variant', 'role', 'autoFocus', 'hover'],
}

describe('what a surface would refuse', () => {
  test('every tree uses only the props, keys and hotkeys a surface accepts', () => {
    for (const [name, draw] of DRAWINGS) {
      for (const width of [12, 24, 40, 60, 100, 200]) {
        const tree = draw(width)
        const keys: string[] = []

        walk(tree as Node, el => {
          const where = `${name} at ${width}: ${el.type}`

          expect(['Box', 'Text', 'Button'], where).toContain(el.type)
          for (const [prop, value] of Object.entries(el.props ?? {})) {
            expect(ALLOWED[el.type] ?? [], `${where} has the prop ${prop}`).toContain(prop)
            expect(['string', 'number', 'boolean'], `${where}.${prop} is a ${typeof value}`).toContain(typeof value)
          }
          if (el.type === 'Button') {
            const props = el.props ?? {}

            expect(typeof props.key === 'string' && props.key !== '', `${where} has no key`).toBe(true)
            expect(typeof props.label === 'string' && props.label !== '', `${where} has no label`).toBe(true)
            expect(props.plain, `${where} is not plain`).toBe(true)
            expect(
              props.hotkey === undefined || /^[0-9a-z]$/.test(String(props.hotkey)),
              `${where} has the hotkey ${String(props.hotkey)}`,
            ).toBe(true)
            expect(el.press, `${where} has no handler`).toBeDefined()
            expect(el.children, `${where} is not a leaf`).toBeUndefined()
            keys.push(String(props.key))
          } else if (el.type === 'Text') {
            // Only a Box or a Button is addressed by a key; one on a Text is dropped.
            expect(el.props?.key, `${where} has a key`).toBeUndefined()
          }
        })
        expect(new Set(keys).size, `${name} at ${width} repeats a Button key: ${keys.join(', ')}`).toBe(keys.length)
        // Plain data all through: nothing a JSON round trip would change.
        expect(JSON.parse(JSON.stringify(tree)), `${name} at ${width} is not plain data`).toEqual(tree)
      }
    }
  })

  test('no text, label or prop holds a control, escape, bidi or zero-width character', () => {
    for (const [name, draw] of DRAWINGS) {
      for (const width of [24, 60]) {
        for (const text of stringsOf(draw(width))) {
          expect(CONTROL.test(text), `${name} at ${width} draws ${JSON.stringify(text)}`).toBe(false)
          expect(INVISIBLE.test(text), `${name} at ${width} draws ${JSON.stringify(text)}`).toBe(false)
        }
      }
    }
  })

  test('keeps what is printable of a hostile text, and nothing an escape sequence carried', () => {
    const work = drawWork(HOSTILE_WORK, { width: 100 }).rows.join('\n')
    const session = drawSession(HOSTILE_SESSION, { width: 100, expanded: 'a1' }).rows.join('\n')

    for (const words of [
      'acme/widgets · feat/x',
      '#42 PR title',
      '#12 Ticket title',
      'build',
      '✗ lint',
      '#40 Board title',
      '#7 Issue title',
      '#38 Queue title',
    ]) {
      expect(work).toContain(words)
    }
    for (const words of [
      'docs 12 calls',
      'explorer · Map it',
      'Bash npm test',
      '■ denied Bash rm -rf build',
      'explorer npm test failed',
      'docs:search 3',
      '» Done and dusted',
    ]) {
      expect(session).toContain(words)
    }
    for (const shown of [work, session]) {
      expect(shown).not.toContain('[31m')
      expect(shown).not.toContain('owned')
    }
  })

  test('draws a problem with control characters in it as plain text too', () => {
    const { rows, tree } = drawWork({ ...HOSTILE_WORK, problem: dirty('gh is gone') })

    expect(rows).toContain('gh is gone')
    expect(textRow(tree, 'gh is gone').props).toMatchObject({ color: 'warning' })
  })

  test('keeps every row inside the width of the pane, wide characters counted by the cells they take', () => {
    for (const [name, draw] of DRAWINGS) {
      for (const width of [12, 20, 24, 32, 40, 60, 100, 200]) {
        for (const row of rowsOf(draw(width), { skipWrapped: true })) {
          expect(cells(row), `${name} at ${width} draws ${JSON.stringify(row)}`).toBeLessThanOrEqual(width)
        }
      }
    }
  })

  test('draws without failing at any width, even one that is no use', () => {
    for (const [name, draw] of DRAWINGS) {
      for (const width of [-1, 0, 1, 2, 3, 5, 8, 11, 12.7, 1e6, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(rowsOf(draw(width)).length, `${name} at ${width}`).toBeGreaterThan(0)
      }
    }
  })

  test('draws every row as a Text the engine would cut at the edge, or wrap, as well', () => {
    // The Texts that are not inside another Text: the rows, as opposed to the pieces of a row.
    const outer = (node: Node, isInside = false): El[] =>
      typeof node === 'string'
        ? []
        : node.type === 'Text' && !isInside
          ? [node]
          : (node.children ?? []).flatMap(child => outer(child, isInside || node.type === 'Text'))

    for (const [name, draw] of DRAWINGS) {
      const rows = outer(draw(40) as Node)

      expect(rows.length, name).toBeGreaterThan(0)
      for (const row of rows) {
        expect(['truncate-end', 'wrap'], `${name}: ${JSON.stringify(textOf(row))}`).toContain(row.props?.wrap)
      }
    }
  })

  test('stays inside the bounds a tree has: 20,000 nodes, 32 deep, 100,000 characters', () => {
    const big: SessionView = {
      ...SESSION,
      mcp: Array.from({ length: 20 }, (_, index) =>
        server({
          server: `server-${index}`,
          inFlight: Array.from({ length: 9 }, (_, call) => ({ id: `${index}-${call}`, tool: `t${call}`, startedAt: NOW - call * SEC })),
        }),
      ),
      agents: Array.from({ length: 30 }, (_, index) =>
        agent({
          id: `a${index}`,
          tools: Array.from({ length: 5 }, (_, tool) => ({ tool: 'Read', text: `f${tool}.ts`, isError: false })),
          answer: 'x'.repeat(2000),
        }),
      ),
      gate: Array.from({ length: 500 }, (_, index) =>
        check(`g${index}`, index % 2 === 0 ? 'asked' : 'rule', { inSubagent: index % 3 === 0 }),
      ),
      log: Array.from({ length: 500 }, (_, index) => entry('edit', NOW - index * SEC, 'main', 'y'.repeat(300))),
      tools: Array.from({ length: 200 }, (_, index) => ({ name: `Tool${index}`, count: index })),
    }
    const manyPrs = Array.from({ length: 100 }, (_, index) =>
      pr({
        number: index + 1,
        title: 'z'.repeat(300),
        checks: Array.from({ length: 50 }, (_, check) => ({ name: `c${check}`, outcome: 'failed' as const })),
      }),
    )
    const bigWork: Work = {
      ...WORK,
      board: manyPrs,
      reviewQueue: manyPrs,
      tickets: Array.from({ length: 50 }, (_, index) => ticket({ number: index })),
      pr: manyPrs[0] ?? null,
    }

    for (const tree of [drawSession(big, { width: 200, expanded: 'a3' }).tree, drawWork(bigWork, { width: 200 }).tree]) {
      let nodes = 0
      let deepest = 0

      walk(tree as Node, (el, depth) => {
        nodes += 1 + (el.children?.length ?? 0)
        deepest = Math.max(deepest, depth + 1)
      })
      expect(nodes).toBeLessThan(20_000)
      expect(deepest).toBeLessThanOrEqual(32)
      expect(JSON.stringify(tree).length).toBeLessThan(100_000)
    }
    // What is shown is capped, so a long session or a busy repository draws the same few rows.
    expect(rowsOf(drawSession(big, { width: 200, expanded: 'a3' }).tree).length).toBeLessThan(110)
    expect(rowsOf(drawWork(bigWork, { width: 200 }).tree).length).toBeLessThan(60)
  })
})

// ---------------------------------------------------------------- through the engine's real kit

const PANE = {
  title: 'Tab',
  isFocused: false,
  bodyColumns: 60,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
} as const

const SURFACES = ['terminal', 'desktop'] as const

// A hook registered through the test's `on` draws the views with the engine's own element table, and
// `$.ui.mount` validates the tree it returns as the surface would: a tree it refuses fails the mount. The
// elements are stamped with the plugin `test`, which is the name the Buttons are pressed under.
describe("through the engine's real kit", () => {
  test('the Work tab mounts on the terminal and the desktop, reads as on the fake surface, and its buttons run their callbacks', async ($, on) => {
    const calls: Calls = { refreshed: 0, copied: [], expanded: [] }

    on('ui.render', { component: 'Pane', requestId: 'views-work' }, ($, e) =>
      workView($.ui.resolve(e), WORK, {
        nowMs: NOW,
        width: e.props.bodyColumns,
        onRefresh: () => {
          calls.refreshed += 1
        },
        onCopy: url => {
          calls.copied.push(url)
        },
      }),
    )
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'test', surface, component: 'Pane', requestId: 'views-work', props: PANE })

      expect(rowsOf(await ui.drawn())).toEqual(drawWork(WORK, { width: PANE.bodyColumns }).rows)
      expect((await ui.findAll({ type: 'Button' })).map(button => button.key)).toEqual(['refresh', 'copy-pr'])
      expect((await ui.find({ key: 'refresh' }))?.text).toBe('↻ 3m')
      await ui.press({ key: 'refresh' })
      await ui.press({ key: 'copy-pr' })
      await ui.unmount()
    }
    expect(calls.refreshed).toBe(2)
    expect(calls.copied).toEqual(['https://github.com/acme/widgets/pull/42', 'https://github.com/acme/widgets/pull/42'])
  })

  test('the Work tab mounts while loading, with nothing to read, and with a problem', async ($, on) => {
    let work: Work | null = null

    on('ui.render', { component: 'Pane', requestId: 'views-work-states' }, ($, e) =>
      workView($.ui.resolve(e), work, { nowMs: NOW, width: e.props.bodyColumns, onRefresh: () => undefined, onCopy: () => undefined }),
    )
    for (const surface of SURFACES) {
      for (const state of [null, EMPTY_WORK, { ...EMPTY_WORK, problem: 'gh is not installed' }]) {
        work = state

        const ui = await $.ui.mount({ plugin: 'test', surface, component: 'Pane', requestId: 'views-work-states', props: PANE })

        expect(rowsOf(await ui.drawn())).toEqual(drawWork(state, { width: PANE.bodyColumns }).rows)
        await ui.unmount()
      }
    }
  })

  test('the Session tab mounts on the terminal and the desktop, and a card opens and closes on a press', async ($, on) => {
    let expanded: string | null = null
    const asked: (string | null)[] = []

    on('ui.render', { component: 'Pane', requestId: 'views-session' }, ($, e) =>
      sessionView($.ui.resolve(e), SESSION, {
        nowMs: NOW,
        width: e.props.bodyColumns,
        expanded,
        onExpand: id => {
          asked.push(id)
          expanded = id
        },
      }),
    )
    for (const surface of SURFACES) {
      expanded = null
      asked.length = 0

      const ui = await $.ui.mount({ plugin: 'test', surface, component: 'Pane', requestId: 'views-session', props: PANE })

      expect(rowsOf(await ui.drawn())).toEqual(drawSession(SESSION, { width: PANE.bodyColumns }).rows)
      expect((await ui.findAll({ type: 'Button' })).map(button => [button.key, button.text])).toEqual([
        ['agent-1', '▸ explorer · Map the module graph'],
        ['agent-2', '✓ reviewer · Check the diff · 2m10s'],
      ])
      await ui.press({ key: 'agent-2' })
      await ui.redraw()
      expect(asked).toEqual(['a2'])
      expect(rowsOf(await ui.drawn())).toEqual(drawSession(SESSION, { width: PANE.bodyColumns, expanded: 'a2' }).rows)
      await ui.press({ key: 'agent-2' })
      await ui.redraw()
      expect(asked).toEqual(['a2', null])
      expect(rowsOf(await ui.drawn())).toEqual(drawSession(SESSION, { width: PANE.bodyColumns }).rows)
      await ui.unmount()
    }
  })

  test('hostile text mounts, where the same text unscrubbed is refused', async ($, on) => {
    let mode: 'work' | 'session' | 'raw' = 'work'

    on('ui.render', { component: 'Pane', requestId: 'views-hostile' }, ($, e) => {
      const kit = $.ui.resolve(e)

      if (mode === 'raw') {
        return kit.Text({ children: `raw ${dirty('text')}` })
      }

      return mode === 'work'
        ? workView(kit, HOSTILE_WORK, { nowMs: NOW, width: e.props.bodyColumns, onRefresh: () => undefined, onCopy: () => undefined })
        : sessionView(kit, HOSTILE_SESSION, { nowMs: NOW, width: e.props.bodyColumns, expanded: 'a1', onExpand: () => undefined })
    })
    for (const surface of SURFACES) {
      for (const shown of ['work', 'session'] as const) {
        mode = shown

        const ui = await $.ui.mount({ plugin: 'test', surface, component: 'Pane', requestId: 'views-hostile', props: PANE })

        expect(rowsOf(await ui.drawn()).length).toBeGreaterThan(10)
        await ui.unmount()
      }

      // The control: this is what the views' scrubbing is for.
      mode = 'raw'
      await expect($.ui.mount({ plugin: 'test', surface, component: 'Pane', requestId: 'views-hostile', props: PANE })).rejects.toThrow(
        'control character',
      )
    }
  })
})
