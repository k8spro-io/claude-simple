// The GitHub side of the mod (hooks/github.ts): the remote, the issues a branch
// names, the one GraphQL query and its argv, and what gh's answer means. Every
// input is a string or a value and nothing here runs gh or touches the engine,
// so every result repeats. The fixtures are generic (acme/widgets, octocat,
// alice) and shaped as GitHub's GraphQL printed them for read-only calls.

import { describe, expect, test } from 'claude-code/testing'

import {
  buildQuery,
  ciOf,
  clean,
  GH_ENV,
  ghArgv,
  isGithub,
  parseAnswer,
  parseRemote,
  ticketNumbersOf,
  type GithubAnswer,
  type GithubData,
  type QueryInput,
  type Remote,
  type TicketNumber,
} from '../hooks/github'
import type { CiRun, Issue, IssueRef, PullRequest } from '../hooks/model'

type Obj = Record<string, unknown>

const REMOTE: Remote = { host: 'github.com', owner: 'acme', name: 'widgets' }
const SHA = '0123456789abcdef0123456789abcdef01234567'
const DEFAULT_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'

function json(value: unknown): string {
  return JSON.stringify(value)
}

/** What a lane asks for, unless a test says otherwise: the branch's pull request and every list. */
function ask(change: Partial<QueryInput> = {}): QueryInput {
  return {
    remote: REMOTE,
    head: 'feat/123-widget-cache',
    hasHead: true,
    lists: true,
    refs: [],
    cacheSeconds: null,
    ...change,
  }
}

// ---------------------------------------------------------------- remote

describe('parseRemote', () => {
  const GITHUB = (owner: string, name: string): Remote => ({ host: 'github.com', owner, name })
  const CASES: [string, string, Remote][] = [
    ['https', 'https://github.com/acme/widgets', GITHUB('acme', 'widgets')],
    ['https with .git', 'https://github.com/acme/widgets.git', GITHUB('acme', 'widgets')],
    ['https with a trailing slash', 'https://github.com/acme/widgets/', GITHUB('acme', 'widgets')],
    ['https with .git and a trailing slash', 'https://github.com/acme/widgets.git/', GITHUB('acme', 'widgets')],
    ['plain http', 'http://github.com/acme/widgets', GITHUB('acme', 'widgets')],
    [
      'a host in capitals (the owner and the name keep theirs)',
      'HTTPS://GitHub.COM/Acme/Widgets',
      GITHUB('Acme', 'Widgets'),
    ],
    ['spaces and a line end around it', '  https://github.com/acme/widgets\n', GITHUB('acme', 'widgets')],
    ['https with a port', 'https://github.com:443/acme/widgets.git', GITHUB('acme', 'widgets')],
    [
      'https with a login and a token',
      'https://octocat:ghp_x1y2@github.com/acme/widgets.git',
      GITHUB('acme', 'widgets'),
    ],
    [
      'https with a password that holds an @',
      'https://octocat:p@ss@github.com/acme/widgets.git',
      GITHUB('acme', 'widgets'),
    ],
    ['scp-like', 'git@github.com:acme/widgets.git', GITHUB('acme', 'widgets')],
    ['scp-like without .git', 'git@github.com:acme/widgets', GITHUB('acme', 'widgets')],
    ['scp-like without a user', 'github.com:acme/widgets.git', GITHUB('acme', 'widgets')],
    ['scp-like with another user', 'org-1234@github.com:acme/widgets.git', GITHUB('acme', 'widgets')],
    ['ssh', 'ssh://git@github.com/acme/widgets.git', GITHUB('acme', 'widgets')],
    ['ssh with a port', 'ssh://git@github.com:22/acme/widgets.git', GITHUB('acme', 'widgets')],
    ['ssh without a user', 'ssh://github.com/acme/widgets', GITHUB('acme', 'widgets')],
    [
      'a name with dots, hyphens and underscores',
      'git@github.com:acme/my.widgets-v2_x.git',
      GITHUB('acme', 'my.widgets-v2_x'),
    ],
    ['a name that ends in .js', 'https://github.com/acme/widgets.js', GITHUB('acme', 'widgets.js')],
    [
      'a name that ends in .git twice (only one is the suffix)',
      'https://github.com/acme/widgets.git.git',
      GITHUB('acme', 'widgets.git'),
    ],
    [
      'an owner and a name of 100 characters',
      `https://github.com/${'o'.repeat(100)}/${'n'.repeat(100)}`,
      GITHUB('o'.repeat(100), 'n'.repeat(100)),
    ],
    [
      'another host, which is still taken apart',
      'https://gitlab.com/acme/widgets.git',
      { host: 'gitlab.com', owner: 'acme', name: 'widgets' },
    ],
    [
      'an enterprise host',
      'git@ghe.example.com:acme/widgets.git',
      { host: 'ghe.example.com', owner: 'acme', name: 'widgets' },
    ],
    [
      'the ssh host of github.com',
      'git@ssh.github.com:acme/widgets.git',
      { host: 'ssh.github.com', owner: 'acme', name: 'widgets' },
    ],
  ]

  for (const [name, url, expected] of CASES) {
    test(`reads ${name}`, () => {
      expect(parseRemote(url)).toEqual(expected)
    })
  }

  const NOT_REMOTES: [string, unknown][] = [
    ['nothing', ''],
    ['only spaces', '   '],
    ['null', null],
    ['undefined', undefined],
    ['a number', 5],
    ['an object', {}],
    ['owner/name alone', 'acme/widgets'],
    ['a name alone', 'widgets'],
    ['an address with no name', 'https://github.com/acme'],
    ['an address with no owner', 'https://github.com/'],
    ['a path of three parts', 'https://github.com/acme/widgets/extra'],
    ['a nested group (not GitHub)', 'https://gitlab.com/group/sub/widgets.git'],
    ['scp-like with no name', 'git@github.com:acme'],
    ['scp-like with a deeper path', 'git@github.com:acme/widgets/extra.git'],
    ['a file URL', 'file:///srv/git/widgets.git'],
    ['a local path', '/srv/git/widgets.git'],
    ['a relative path', '../widgets'],
    ['a Windows path', 'C:\\repos\\widgets'],
    ['a query after the name', 'https://github.com/acme/widgets?tab=readme'],
    ['a fragment after the name', 'https://github.com/acme/widgets#readme'],
    ['a space in the name', 'https://github.com/acme/wid gets'],
    ['a line break in the name', 'git@github.com:acme/wid\nets.git'],
    ['a character outside the set in the owner', 'https://github.com/ac$me/widgets'],
    ['an accented letter in the name', 'https://github.com/acme/wïdgets'],
    ['a search qualifier in the owner', 'https://github.com/acme+org:evil/widgets'],
    ['an owner of 101 characters', `https://github.com/${'o'.repeat(101)}/widgets`],
    ['a name of 101 characters', `https://github.com/acme/${'n'.repeat(101)}`],
    ['an address of 3000 characters', `https://github.com/acme/${'n'.repeat(3000)}`],
    ['an IPv6 host', 'https://[::1]/acme/widgets'],
    ['an unknown scheme', 'ftp://github.com/acme/widgets'],
  ]

  for (const [name, value] of NOT_REMOTES) {
    test(`gives nothing for ${name}`, () => {
      expect(parseRemote(value as never)).toBeNull()
    })
  }
})

describe('isGithub', () => {
  test('is true for github.com and only for it (version 1 asks nothing of another host)', () => {
    expect(isGithub({ host: 'github.com', owner: 'acme', name: 'widgets' })).toBe(true)
    for (const host of [
      'gitlab.com',
      'ssh.github.com',
      'github.com.evil.example',
      'notgithub.com',
      'ghe.example.com',
      '',
    ]) {
      expect(isGithub({ host, owner: 'acme', name: 'widgets' })).toBe(false)
    }
  })

  test('is false when there is no remote', () => {
    expect(isGithub(null)).toBe(false)
    expect(isGithub(undefined)).toBe(false)
    expect(isGithub(parseRemote('/srv/git/widgets.git'))).toBe(false)
  })

  test('follows parseRemote for the usual remotes', () => {
    expect(isGithub(parseRemote('git@github.com:acme/widgets.git'))).toBe(true)
    expect(isGithub(parseRemote('https://github.com:443/acme/widgets'))).toBe(true)
    expect(isGithub(parseRemote('https://gitlab.com/acme/widgets'))).toBe(false)
  })
})

// ---------------------------------------------------------------- tickets

describe('ticketNumbersOf', () => {
  // The rules are the stricter of the two the mod tried: a number counts only
  // where a branch segment starts with it, or after gh-/issue-. A looser rule
  // (any number of two digits in the body) read `feat/widget-scale-90` as issue 90.
  const BRANCHES: [string, number[]][] = [
    ['feat/123-widget-cache', [123]],
    ['123-widget-cache', [123]],
    ['fix/42', [42]],
    ['bugfix/7_retry', [7]],
    ['gh-123-x', [123]],
    ['fix/GH-123', [123]],
    ['gh_9', [9]],
    ['feature/issue-88-login', [88]],
    ['issues_9', [9]],
    ['user/alice/55-thing', [55]],
    ['issue/66', [66]],
    ['bug/12/13-x', [12, 13]],
    ['gh-2024-x', [2024]],
    ['issue-1999', [1999]],
    ['2100-x', [2100]],
    ['1899-x', [1899]],
    ['feat/999999-x', [999999]],
    ['main', []],
    ['HEAD', []],
    ['', []],
    ['release/1.2.3', []],
    ['2024-q4-plan', []],
    ['release/2024-10', []],
    ['2023', []],
    ['1900-x', []],
    ['2099-x', []],
    ['hotfix/20241007-x', []],
    ['feat/1234567-x', []],
    ['007-bond', []],
    ['0-x', []],
    ['3d-printing', []],
    ['feat/abc123', []],
    ['fix-12-null', []],
    ['ABC-123-x', []],
    ['PROJ-9', []],
    ['feat/gh123', []],
    ['feat/high-5-fives', []],
    ['tissue-12', []],
    ['deps/acme/widget-kit-4.17.21', []],
    ['feat/widget-scale-90', []],
    ['feat/cache-default-512', []],
    ['hotfix/ui-318-b', []],
    ['worktree-job_0f1e2d3c-512-2', []],
    ['dependabot/npm_and_yarn/acme/widget-kit-4.17.21', []],
    ['renovate/lodash-4.x', []],
    ['batch/backend-2026-09-22-b', []],
    ['chore/docs-audit-2026-09-26', []],
  ]

  for (const [branch, numbers] of BRANCHES) {
    test(`reads ${numbers.length === 0 ? 'no issue' : `#${numbers.join(' and #')}`} from the branch "${branch}"`, () => {
      expect(ticketNumbersOf(branch, '', [])).toEqual(numbers.map(number => ({ number, source: 'branch' })))
    })
  }

  const MESSAGES: [string, string, number[]][] = [
    ['a subject', 'Fix the crash (#45)', [45]],
    ['a closing line in a body', 'Fix the crash\n\nCloses #12', [12]],
    ['every closing keyword', 'closes #1\nfixes #2\nresolves: #3\nFixed #4\nRESOLVED #5', [1, 2, 3, 4, 5]],
    ['a list', 'see #1, #2 and #3.', [1, 2, 3]],
    ['a brackets form', '[#7] retry, "#8", <#9>', [7, 8, 9]],
    ['the start of the text', '#12 first', [12]],
    ['the start of a line', 'a\n#12\nb', [12]],
    ['a colon before it', 'fixes:#12', [12]],
    ['a full stop after it', 'wip #12.', [12]],
    ['a hyphen after it', 'see #12-13', [12]],
    [
      'subjects and bodies of several commits',
      'Add a cache\n\nRefs #3\nSigned-off-by: A <a@example.com>\nAdd tests (#4)\n\nCo-authored-by: B <b@example.com>',
      [3, 4],
    ],
    ['a repeat, once', '#5 and again #5', [5]],
    ['another repository', 'See acme/other#9', []],
    ['a word before it', 'C#10 and foo#11 and a1#12', []],
    ['an accented word before it', 'café#12 and ß#13', []],
    ['a URL fragment', 'https://example.com/page#12 and https://example.com/#13', []],
    ['an HTML entity', 'it&#35;s &#123;', []],
    ['a second hash', '##12', []],
    ['more than six digits', '#1234567', []],
    ['a leading zero', '#0 and #007 and #012', []],
    ['a word after it', '#12abc and #12_x and #12é', []],
    ['a heading', '# 12 and #', []],
    ['nothing', '', []],
    ['text with no reference', 'Fix the crash.\n\nSee the docs.', []],
  ]

  for (const [name, messages, numbers] of MESSAGES) {
    test(`reads ${numbers.length === 0 ? 'no issue' : `#${numbers.join(' and #')}`} from ${name}`, () => {
      expect(ticketNumbersOf('', messages, [])).toEqual(numbers.map(number => ({ number, source: 'commit' })))
    })
  }

  test('reads the pull request closing issues as they come', () => {
    expect(ticketNumbersOf('', '', [8, 3])).toEqual([
      { number: 8, source: 'pr' },
      { number: 3, source: 'pr' },
    ])
  })

  test('ignores a closing number that is not a number of an issue', () => {
    expect(ticketNumbersOf('', '', [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 4])).toEqual([
      { number: 4, source: 'pr' },
    ])
  })

  test('orders branch, then pull request, then commits', () => {
    expect(ticketNumbersOf('feat/1-x', 'Refs #3\nRefs #4', [2])).toEqual([
      { number: 1, source: 'branch' },
      { number: 2, source: 'pr' },
      { number: 3, source: 'commit' },
      { number: 4, source: 'commit' },
    ])
  })

  test('keeps the first source of an issue found twice', () => {
    expect(ticketNumbersOf('feat/5-x', 'Closes #5\nCloses #6', [5, 6, 7])).toEqual([
      { number: 5, source: 'branch' },
      { number: 6, source: 'pr' },
      { number: 7, source: 'pr' },
    ])
  })

  test('gives at most five, the earliest sources first', () => {
    const found = ticketNumbersOf('feat/1-x', '#8 #9 #10', [2, 3, 4, 5, 6])

    expect(found.map(one => one.number)).toEqual([1, 2, 3, 4, 5])
    expect(found.every(one => one.source !== 'commit')).toBe(true)
  })

  test('is empty when there is nothing to read, and does not throw on what is not text', () => {
    expect(ticketNumbersOf('', '', [])).toEqual([])
    expect(ticketNumbersOf(undefined as never, undefined as never, [])).toEqual([])
    expect(ticketNumbersOf(null as never, 5 as never, [])).toEqual([])
  })

  test('reads a long log in one pass', () => {
    const log =
      Array.from({ length: 5000 }, (_, index) => `commit ${index} touches foo#${index}\n\nbody`).join('\n') +
      '\nCloses #77'

    expect(ticketNumbersOf('', log, [])).toEqual([{ number: 77, source: 'commit' }])
  })

  test('gives what a query takes as its refs', () => {
    const refs: QueryInput['refs'] = ticketNumbersOf('feat/1-x', '#2', [])
    const one: TicketNumber | undefined = refs[0]

    expect(one).toEqual({ number: 1, source: 'branch' })
  })
})

// ---------------------------------------------------------------- the query

/** The text between the braces that open at `from` and close with them; '' when they never close. */
function braced(text: string, from: number): string {
  const open = text.indexOf('{', from)
  let depth = 0

  for (let at = open; open >= 0 && at < text.length; at += 1) {
    depth += text[at] === '{' ? 1 : text[at] === '}' ? -1 : 0
    if (depth === 0) {
      return text.slice(open, at + 1)
    }
  }

  return ''
}

/** One selection of the query, by what it starts with: `team: pullRequests(...) @include(if: $lists) { ... }`, or `defaultBranchRef { ... }`. */
function selection(query: string, start: string): string {
  const at = query.indexOf(start)
  const open = query.indexOf('{', at)
  const args = query.indexOf('(', at)

  // Arguments come first when a parenthesis stands before the selection's own brace.
  return at < 0 ? '' : braced(query, args >= 0 && args < open ? query.indexOf(')', args) : at)
}

describe('buildQuery', () => {
  const QUERY = buildQuery([123, 45])

  test('looks up each number as an aliased issueOrPullRequest', () => {
    expect(QUERY).toContain(
      'r123: issueOrPullRequest(number: 123) { __typename ... on Issue { number title state url } ... on PullRequest { number } }',
    )
    expect(QUERY).toContain('r45: issueOrPullRequest(number: 45)')
    expect(QUERY).not.toContain('r7:')
  })

  test('is a query, not a mutation, whatever it is given', () => {
    expect(QUERY.startsWith('query Work(')).toBe(true)
    expect(QUERY).not.toMatch(/mutation|subscription/i)
  })

  test('writes only validated whole numbers into the text', () => {
    const hostile = [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      2 ** 31,
      2 ** 53,
      1e21,
      Number.MAX_VALUE,
    ]

    expect(buildQuery(hostile)).toBe(buildQuery([]))
    expect(buildQuery(['7', null, undefined, {}, [3], '1) { x } #'] as never)).toBe(buildQuery([]))
    expect(buildQuery([0, 5, -2, 1.5])).toBe(buildQuery([5]))
    expect(buildQuery([5])).toContain('r5: issueOrPullRequest(number: 5)')
    expect(QUERY).not.toMatch(/undefined|NaN|Infinity|\[object|null\b/)
  })

  test('takes a number up to the largest GraphQL Int, and not above', () => {
    expect(buildQuery([2_147_483_647])).toContain('r2147483647: issueOrPullRequest(number: 2147483647)')
    expect(buildQuery([2_147_483_648])).toBe(buildQuery([]))
  })

  test('looks each number up once, and at most five', () => {
    const lookups = (query: string): string[] =>
      [...query.matchAll(/\br(\d+): issueOrPullRequest/g)].map(match => match[1] ?? '')

    expect(lookups(buildQuery([1, 1, 2, 2, 3]))).toEqual(['1', '2', '3'])
    expect(lookups(buildQuery([1, 2, 3, 4, 5, 6, 7]))).toEqual(['1', '2', '3', '4', '5'])
    expect(lookups(buildQuery([]))).toEqual([])
  })

  test('declares the variables it uses, and uses every one it declares (GraphQL refuses an unused variable)', () => {
    const header = QUERY.slice(0, QUERY.indexOf(') {'))
    const body = QUERY.slice(QUERY.indexOf(') {'))
    const declared = [...header.matchAll(/\$(\w+):/g)].map(match => match[1] ?? '')
    const used = unique([...body.matchAll(/\$(\w+)/g)].map(match => match[1] ?? ''))

    expect(declared).toEqual(['owner', 'name', 'head', 'headRef', 'hasHead', 'lists', 'qReview', 'qAssigned'])
    expect([...used].sort()).toEqual([...declared].sort())
    expect(header).toContain('$headRef: String!')
    expect(header).toContain('$hasHead: Boolean!')
    expect(header).toContain('$lists: Boolean!')
  })

  test('has balanced braces and parentheses', () => {
    for (const query of [buildQuery([]), QUERY]) {
      for (const [open, close] of [
        ['{', '}'],
        ['(', ')'],
      ] as const) {
        expect(query.split(open).length).toBe(query.split(close).length)
      }
    }
  })

  test('asks for the branch only when there is one: head commit checks and open pull requests', () => {
    expect(QUERY).toMatch(/branch: ref\(qualifiedName: \$headRef\) @include\(if: \$hasHead\)/)
    // Open ones only: three closed ones updated later (a release bot's comment) would push the open one out.
    expect(QUERY).toMatch(
      /head: pullRequests\(headRefName: \$head, states: OPEN, first: 3, [^)]*\) @include\(if: \$hasHead\)/,
    )
  })

  test('asks for the lists only while the pane is open', () => {
    expect(QUERY).toMatch(/team: pullRequests\(states: OPEN, first: 8, [^)]*\) @include\(if: \$lists\)/)
    expect(QUERY).toMatch(/review: search\(query: \$qReview, type: ISSUE, first: 5\) @include\(if: \$lists\)/)
    expect(QUERY).toMatch(/assigned: search\(query: \$qAssigned, type: ISSUE, first: 5\) @include\(if: \$lists\)/)
  })

  test('asks for the head commit of the branch with its checks, to the letter', () => {
    expect(QUERY).toContain(
      'branch: ref(qualifiedName: $headRef) @include(if: $hasHead) { target { ... on Commit { oid statusCheckRollup { state contexts(first: 50) { totalCount nodes { __typename ... on CheckRun { name status conclusion startedAt completedAt detailsUrl } ... on StatusContext { context state createdAt targetUrl } } } } } } }',
    )
  })

  test('asks for the checks of the default branch head commit as well, contexts included', () => {
    const block = selection(QUERY, 'defaultBranchRef')

    expect(block).toContain('name')
    expect(block).toContain('... on Commit { oid statusCheckRollup { state contexts(first: 50) { totalCount nodes {')
    expect(block).toContain('detailsUrl')
    expect(block).toContain('targetUrl')
  })

  test('keeps the checks off the rows of the lists: with them a big repository answers 300 KB and a 504', () => {
    for (const start of ['team: pullRequests', 'review: search', 'assigned: search']) {
      const block = selection(QUERY, start)

      expect(block).toStartWith('{')
      expect(block).toContain('nodes {')
      expect(block).toEndWith('}')
      expect(block).not.toContain('statusCheckRollup')
      expect(block).not.toContain('contexts')
    }
    expect(QUERY.match(/statusCheckRollup/g)).toHaveLength(3)
  })

  test('asks for what the rows need', () => {
    const fragment = QUERY.slice(QUERY.indexOf('fragment Pr on PullRequest'))

    for (const field of [
      'number',
      'title',
      'url',
      'isDraft',
      'reviewDecision',
      'author { login }',
      'headRefName',
      'updatedAt',
    ]) {
      expect(fragment).toContain(field)
    }
    expect(selection(QUERY, 'team: pullRequests')).toContain(
      'closingIssuesReferences(first: 2) { nodes { number repository { nameWithOwner } } }',
    )
    expect(selection(QUERY, 'assigned: search')).toContain(
      'closedByPullRequestsReferences(first: 1, includeClosedPrs: false) { nodes { number } }',
    )
  })

  test('asks for what the branch pull request needs', () => {
    const block = selection(QUERY, 'head: pullRequests')

    for (const field of [
      'state',
      'isCrossRepository',
      'mergeStateStatus',
      'autoMergeRequest',
      'reviewRequests(first: 4)',
      'latestReviews(first: 4)',
      'closingIssuesReferences(first: 4) { nodes { number title state url repository { nameWithOwner } } }',
      'statusCheckRollup',
    ]) {
      expect(block).toContain(field)
    }
    expect(block).toContain('... on Team { slug }')
  })

  test('is the same text every time', () => {
    expect(buildQuery([1, 2])).toBe(buildQuery([1, 2]))
    expect(buildQuery([1, 2])).not.toBe(buildQuery([2, 1]))
  })
})

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)]
}

// ---------------------------------------------------------------- argv

describe('ghArgv', () => {
  const REFS: TicketNumber[] = [
    { number: 123, source: 'branch' },
    { number: 45, source: 'commit' },
  ]
  const OWNER_SEARCH = 'user:acme is:pr is:open review-requested:@me archived:false sort:updated-desc'
  const ASSIGNED_SEARCH = 'user:acme is:issue is:open assignee:@me archived:false sort:updated-desc'

  test('is the exact command line of a fresh call', () => {
    expect(ghArgv(ask({ refs: REFS }))).toEqual([
      'gh',
      'api',
      'graphql',
      '--hostname',
      'github.com',
      '-f',
      `query=${buildQuery([123, 45])}`,
      '-f',
      'owner=acme',
      '-f',
      'name=widgets',
      '-f',
      'head=feat/123-widget-cache',
      '-f',
      'headRef=refs/heads/feat/123-widget-cache',
      '-F',
      'hasHead=true',
      '-F',
      'lists=true',
      '-f',
      `qReview=${OWNER_SEARCH}`,
      '-f',
      `qAssigned=${ASSIGNED_SEARCH}`,
    ])
  })

  test('is the exact command line of a cached one, the cache flag right after the pinned host', () => {
    expect(ghArgv(ask({ refs: REFS, cacheSeconds: 110, lists: false }))).toEqual([
      'gh',
      'api',
      'graphql',
      '--hostname',
      'github.com',
      '--cache',
      '110s',
      '-f',
      `query=${buildQuery([123, 45])}`,
      '-f',
      'owner=acme',
      '-f',
      'name=widgets',
      '-f',
      'head=feat/123-widget-cache',
      '-f',
      'headRef=refs/heads/feat/123-widget-cache',
      '-F',
      'hasHead=true',
      '-F',
      'lists=false',
      '-f',
      `qReview=${OWNER_SEARCH}`,
      '-f',
      `qAssigned=${ASSIGNED_SEARCH}`,
    ])
  })

  test('asks for no branch when there is none: empty head, empty ref, hasHead false', () => {
    const argv = ghArgv(ask({ hasHead: false, head: 'main' }))

    expect(argv).toContain('head=')
    expect(argv).toContain('headRef=')
    expect(argv).toContain('hasHead=false')
    expect(argv.join('\n')).not.toContain('refs/heads/')
  })

  test('takes hasHead with no branch name as no branch', () => {
    const argv = ghArgv(ask({ hasHead: true, head: '' }))

    expect(argv).toContain('hasHead=false')
    expect(argv).toContain('head=')
    expect(argv).toContain('headRef=')
  })

  test('puts the lookups of the refs it was given into the query, and nothing else', () => {
    const argv = ghArgv(ask({ refs: REFS }))

    expect(argv).toContain(`query=${buildQuery([123, 45])}`)
    expect(argv.filter(part => part.startsWith('query='))).toHaveLength(1)
    expect(ghArgv(ask())).toContain(`query=${buildQuery([])}`)
  })

  const CACHES: [number | null, string[]][] = [
    [null, []],
    [110, ['--cache', '110s']],
    [55, ['--cache', '55s']],
    [1, ['--cache', '1s']],
    [55.9, ['--cache', '55s']],
    [0, []],
    [0.5, []],
    [-3, []],
    [Number.NaN, []],
    [Number.POSITIVE_INFINITY, []],
    [1e21, []],
  ]

  for (const [seconds, flags] of CACHES) {
    test(`${seconds === null ? 'no cache' : `a cache of ${seconds}`} is ${flags.length === 0 ? 'a fresh call' : flags.join(' ')}`, () => {
      expect(ghArgv(ask({ cacheSeconds: seconds })).slice(5, 5 + flags.length)).toEqual(flags)
      expect(ghArgv(ask({ cacheSeconds: seconds })).includes('--cache')).toBe(flags.length > 0)
    })
  }

  test('always asks github.com, whatever GH_HOST or the logged-in hosts say', () => {
    for (const cacheSeconds of [null, 110]) {
      expect(ghArgv(ask({ cacheSeconds })).slice(0, 5)).toEqual(['gh', 'api', 'graphql', '--hostname', 'github.com'])
    }
  })

  test('gives each value its own argument: what a branch name holds reaches gh as it is, through -f only', () => {
    for (const head of [
      '@/etc/passwd',
      '--limit=1',
      '$(id)',
      'a b',
      'x=y',
      '-x',
      "it's",
      'feat/ü-ñ',
      '{owner}/{repo}',
      'true',
      '"; rm -rf /',
    ]) {
      const argv = ghArgv(ask({ head }))
      const at = argv.indexOf(`head=${head}`)

      expect(argv.filter(part => part === `head=${head}`)).toHaveLength(1)
      expect(argv[at - 1]).toBe('-f')
      expect(argv.filter(part => part === `headRef=refs/heads/${head}`)).toHaveLength(1)
      expect(argv[argv.indexOf(`headRef=refs/heads/${head}`) - 1]).toBe('-f')
      // The value never stands alone, where gh would take it for a flag, and never in the query.
      expect(argv).not.toContain(head)
      expect(argv.find(part => part.startsWith('query='))).not.toContain(head)
    }
  })

  test('uses -F only for the two flags it writes itself: gh reads @file and {owner} in what -F carries', () => {
    for (const lists of [true, false]) {
      for (const hasHead of [true, false]) {
        const argv = ghArgv(ask({ lists, hasHead, head: '@secret', refs: REFS }))
        const typed = argv.flatMap((part, at) => (part === '-F' ? [argv[at + 1]] : []))

        expect(typed).toEqual([`hasHead=${String(hasHead)}`, `lists=${String(lists)}`])
      }
    }
  })

  test('follows every flag with a key=value, and holds nothing empty', () => {
    const argv = ghArgv(ask({ refs: REFS, cacheSeconds: 55 }))

    expect(argv.every(part => part !== '')).toBe(true)
    for (const [at, part] of argv.entries()) {
      if (part === '-f' || part === '-F') {
        expect(argv[at + 1]).toMatch(/^[A-Za-z]+=/)
      }
    }
  })

  test('scopes both searches to the owner, and to no one else', () => {
    for (const owner of ['acme', 'octo-org', 'a.b_c', 'A1']) {
      const argv = ghArgv(ask({ remote: { host: 'github.com', owner, name: 'widgets' } }))

      expect(argv).toContain(
        `qReview=user:${owner} is:pr is:open review-requested:@me archived:false sort:updated-desc`,
      )
      expect(argv).toContain(`qAssigned=user:${owner} is:issue is:open assignee:@me archived:false sort:updated-desc`)
      expect(argv).toContain(`owner=${owner}`)
    }
  })

  test('refuses an owner or a name that could add to the search, or to the text', () => {
    for (const owner of ['ac me', 'acme org:evil', '', 'acme\nuser:other', 'acme"', 'ac/me', 'ü']) {
      expect(() => ghArgv(ask({ remote: { host: 'github.com', owner, name: 'widgets' } }))).toThrow(RangeError)
    }
    for (const name of ['wid gets', '', '../x', 'widgets;', 'a'.repeat(101)]) {
      expect(() => ghArgv(ask({ remote: { host: 'github.com', owner: 'acme', name } }))).toThrow(RangeError)
    }
  })

  test('hands out a new list each time, so a caller that changes it changes nothing else', () => {
    const mine = ghArgv(ask())

    mine.push('--web')
    expect(ghArgv(ask())).not.toContain('--web')
  })

  test('passes every variable the query declares, and no other, in the order it declares them', () => {
    const query = buildQuery([])
    const declared = [...query.slice(0, query.indexOf(') {')).matchAll(/\$(\w+):/g)].map(match => match[1])
    const argv = ghArgv(ask())
    const keys = argv.flatMap((part, at) =>
      part === '-f' || part === '-F' ? [(argv[at + 1] ?? '').split('=')[0]] : [],
    )

    expect(keys).toEqual(['query', ...declared])
  })
})

describe('GH_ENV', () => {
  test('keeps gh from prompting, checking for updates, spinning, paging and colouring', () => {
    expect(GH_ENV).toEqual({
      GH_PROMPT_DISABLED: '1',
      GH_NO_UPDATE_NOTIFIER: '1',
      GH_NO_EXTENSION_UPDATE_NOTIFIER: '1',
      GH_SPINNER_DISABLED: '1',
      GH_PAGER: 'cat',
      NO_COLOR: '1',
      CLICOLOR_FORCE: '0',
    })
  })

  test('undoes a colour the person forces, which NO_COLOR alone does not (gh 2.97 colours its JSON then)', () => {
    expect(GH_ENV.CLICOLOR_FORCE).toBe('0')
    expect(GH_ENV.NO_COLOR).toBe('1')
  })

  test('is the env a process run takes', () => {
    const env: Record<string, string> = GH_ENV

    expect(Object.values(env).every(value => typeof value === 'string')).toBe(true)
  })

  test('cannot be changed by a caller that shares it', () => {
    expect(Object.isFrozen(GH_ENV)).toBe(true)
  })
})

// ---------------------------------------------------------------- clean

/** What `clean` must never leave: a control character (the engine refuses a Text holding one), a format character or a lone surrogate. */
const UNFIT = /[\p{Cc}\p{Cf}\p{Cs}]/u

/** A generator that always gives the same run of numbers for a seed, so a failure repeats. */
function seeded(seed: number): () => number {
  let state = seed

  return () => {
    state = (state + 0x6d2b79f5) | 0

    let mixed = Math.imul(state ^ (state >>> 15), 1 | state)

    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed

    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

/** The pieces the random strings are built from: controls, escapes, format characters, surrogate halves, text. */
const PIECES: readonly string[] = [
  ...Array.from({ length: 32 }, (_, code) => String.fromCharCode(code)),
  '\u007f',
  '\u0085',
  '\u009b',
  '\u009d',
  '\u001b[',
  '\u001b]8;;',
  '\u001bP',
  '\u001b\\',
  '\u001b(B',
  '\u001b[31m',
  '\u200b',
  '\u200d',
  '\u200e',
  '\u202e',
  '\u2066',
  '\u2069',
  '\ufeff',
  '\u00ad',
  '\u061c',
  '\u{e0041}',
  '\u2028',
  '\u00a0',
  '\u3000',
  '\ud800',
  '\udc00',
  '\u{1f600}',
  '\u{1f469}\u200d\u{1f4bb}',
  '\ufe0f',
  'a',
  'b',
  'Z',
  '0',
  '9',
  ' ',
  '  ',
  '[',
  ';',
  '\\',
  '#',
  '…',
  'é',
  '日本',
]

describe('clean', () => {
  const CASES: [string, string, number, string][] = [
    ['leaves plain text alone', 'Add the widget cache', 80, 'Add the widget cache'],
    ['collapses runs of whitespace and trims', '  a \t\t b   c  ', 80, 'a b c'],
    [
      'turns line breaks and tabs into spaces, not into nothing',
      'a\nb\r\nc\td\u0085e\u000bf\u000cg',
      80,
      'a b c d e f g',
    ],
    ['turns every kind of space into one space', 'a\u00a0b\u2003c\u3000d\u2028e\u2029f', 80, 'a b c d e f'],
    ['removes colour escapes', '\u001b[31mred\u001b[0m and \u001b[1;38;5;196mmore\u001b[0m', 80, 'red and more'],
    ['removes cursor moves and erases', 'a\u001b[2J\u001b[10;5Hb\u001b[K', 80, 'ab'],
    [
      'removes a hyperlink escape, keeping its label (BEL end)',
      'see \u001b]8;;https://example.com\u0007link\u001b]8;;\u0007!',
      80,
      'see link!',
    ],
    [
      'removes a hyperlink escape, keeping its label (ST end)',
      'see \u001b]8;;https://example.com\u001b\\link\u001b]8;;\u001b\\!',
      80,
      'see link!',
    ],
    ['removes a title escape that never ends', 'a\u001b]0;a title that never ends', 80, 'a'],
    ['removes a device control string', 'a\u001bP1$r0m\u001b\\b', 80, 'ab'],
    [
      'removes an application program command, a privacy message and a start of string',
      'a\u001b_Gf=100;AAAA\u001b\\b\u001b^note\u001b\\c\u001bXtext\u001b\\d',
      80,
      'abcd',
    ],
    ['removes private-mode escapes', 'a\u001b[?25lb\u001b[?1049hc\u001b[>0q', 80, 'abc'],
    ['removes an escape with intermediate bytes', 'a\u001b[2 qb\u001b[0"pc', 80, 'abc'],
    ['removes a charset escape without leaving its letter', 'x\u001b(By', 80, 'xy'],
    [
      'removes a one-byte C1 control without taking the text after it (a mis-decoded quote)',
      'a\u009b31mb\u009dc\u0090d\u009fe',
      80,
      'a31mbcde',
    ],
    ['removes an escape cut off at the end', 'a\u001b', 80, 'a'],
    ['removes control characters', 'a\u0000b\u0007c\u007fd\u0080e\u009ff', 80, 'abcdef'],
    [
      'removes bidi controls',
      'abc\u202edef\u2066ghi\u2069\u200ejkl\u200f\u061cmno\u202a\u202b\u202c\u202d',
      80,
      'abcdefghijklmno',
    ],
    [
      'removes zero-width characters, the BOM, the soft hyphen, the word joiner and tag characters',
      'a\u200bb\u200cc\u200dd\ufeffe\u00adf\u2060g\u{e0041}h\u180ei',
      80,
      'abcdefghi',
    ],
    ['removes a lone surrogate half', 'a\ud800b\udc00c', 80, 'abc'],
    ['keeps an emoji, and the letters of other scripts', 'café naïve 日本語 😀', 80, 'café naïve 日本語 😀'],
    ['cuts with an ellipsis, in at most max characters', 'abcdefghij', 5, 'abcd…'],
    ['does not cut text of exactly max characters', 'abcde', 5, 'abcde'],
    ['cuts text one character over', 'abcdef', 5, 'abcd…'],
    ['drops the space before the ellipsis', 'hello world', 7, 'hello…'],
    ['never cuts through an emoji', '😀😀😀😀', 3, '😀😀…'],
    ['cuts after cleaning, so removed characters do not count', '\u200b\u200bab\u200bc', 3, 'abc'],
    ['gives only the ellipsis at max 1', 'abc', 1, '…'],
    ['gives a single character at max 1 when it fits', 'a', 1, 'a'],
    ['rounds max down', 'abcdef', 3.9, 'ab…'],
    ['gives nothing for a max of 0', 'abc', 0, ''],
    ['gives nothing for a negative max', 'abc', -4, ''],
    ['gives nothing for a max that is not a number', 'abc', Number.NaN, ''],
    ['does not cut at an infinite max', 'abc', Number.POSITIVE_INFINITY, 'abc'],
    ['gives nothing for nothing', '', 10, ''],
  ]

  for (const [name, input, max, expected] of CASES) {
    test(name, () => {
      expect(clean(input, max)).toBe(expected)
    })
  }

  test('keeps 200 characters unless told otherwise', () => {
    expect(clean('a'.repeat(200))).toBe('a'.repeat(200))
    expect(clean('a'.repeat(201))).toBe(`${'a'.repeat(199)}…`)
    expect(Array.from(clean('😀'.repeat(500)))).toHaveLength(200)
  })

  test('gives nothing for what is not a string', () => {
    for (const value of [undefined, null, 42, {}, ['a'], true]) {
      expect(clean(value, 10)).toBe('')
      expect(clean(value)).toBe('')
    }
  })

  test('cleans a second time to the same text, and leaves no control, format or lone-surrogate character', () => {
    for (const [, input, max] of CASES) {
      const once = clean(input, max)

      expect(clean(once, max)).toBe(once)
      expect(UNFIT.test(once)).toBe(false)
      expect(Array.from(once).length).toBeLessThanOrEqual(Number.isNaN(max) ? 0 : Math.max(0, Math.floor(max)))
    }
  })

  test('holds for strings put together at random from the characters that matter', () => {
    const random = seeded(20261007)
    const results = new Set<string>()

    for (let run = 0; run < 2000; run += 1) {
      const length = Math.floor(random() * 40)
      const max = 1 + Math.floor(random() * 60)
      let input = ''

      for (let at = 0; at < length; at += 1) {
        input += PIECES[Math.floor(random() * PIECES.length)] ?? ''
      }

      const once = clean(input, max)

      results.add(once)
      expect(UNFIT.test(once)).toBe(false)
      expect(once).toBe(once.trim())
      expect(once).not.toMatch(/\s\s/)
      expect(Array.from(once).length).toBeLessThanOrEqual(max)
      expect(clean(once, max)).toBe(once)
    }
    // The generator really did reach many different texts.
    expect(results.size).toBeGreaterThan(1000)
  })

  test('is linear in what it is given: a long run of unfinished escapes does not stall it', () => {
    const open = '\u001b['.repeat(100_000)
    const digits = `\u001b[${'0'.repeat(200_000)}`
    const title = `\u001b]0;${'x'.repeat(200_000)}`
    const nulls = `${'\u0000'.repeat(200_000)}z`

    expect(clean(`${open}é`, 10)).toBe('é')
    expect(clean(digits, 5)).toBe('0000…')
    expect(clean(`${title}\u0007y`, 10)).toBe('y')
    expect(clean(nulls, 10)).toBe('z')
  })
})

// ---------------------------------------------------------------- fixtures: checks and CI

function checkRun(name: string, status: string, conclusion: string | null, change: Obj = {}): Obj {
  return {
    __typename: 'CheckRun',
    name,
    status,
    conclusion,
    startedAt: '2026-10-07T10:00:00Z',
    completedAt: status === 'COMPLETED' ? '2026-10-07T10:05:00Z' : null,
    detailsUrl: 'https://github.com/acme/widgets/actions/runs/1/job/1',
    ...change,
  }
}

function statusContext(context: string, state: string, change: Obj = {}): Obj {
  return {
    __typename: 'StatusContext',
    context,
    state,
    createdAt: '2026-10-07T10:00:00Z',
    targetUrl: 'https://ci.example.com/7',
    ...change,
  }
}

function rollup(state: string, nodes: readonly unknown[], totalCount: number = nodes.length): Obj {
  return { state, contexts: { totalCount, nodes } }
}

function commit(statusCheckRollup: unknown, oid: string = SHA): Obj {
  return { oid, statusCheckRollup }
}

const AT = (time: string): number => Date.parse(`2026-10-07T${time}Z`)

describe('ciOf', () => {
  test('is passed when every check passed, as of the last one that ended', () => {
    const ci = ciOf(
      commit(
        rollup('SUCCESS', [
          checkRun('build', 'COMPLETED', 'SUCCESS', { completedAt: '2026-10-07T10:05:00Z' }),
          checkRun('test', 'COMPLETED', 'SUCCESS', { completedAt: '2026-10-07T10:20:00Z' }),
          statusContext('deploy/preview', 'SUCCESS', { createdAt: '2026-10-07T10:10:00Z' }),
        ]),
      ),
    )

    expect(ci).toEqual({
      workflow: '',
      outcome: 'passed',
      isRunning: false,
      at: AT('10:20:00'),
      url: '',
      sha: '0123456',
    })
  })

  test('is failed when any check failed, named by the first that did, with its link', () => {
    const ci = ciOf(
      commit(
        rollup('FAILURE', [
          checkRun('build', 'COMPLETED', 'SUCCESS'),
          checkRun('lint', 'COMPLETED', 'FAILURE', {
            detailsUrl: 'https://github.com/acme/widgets/actions/runs/1/job/12',
          }),
          checkRun('test', 'COMPLETED', 'TIMED_OUT', {
            detailsUrl: 'https://github.com/acme/widgets/actions/runs/1/job/13',
          }),
        ]),
      ),
    )

    expect(ci).toEqual({
      workflow: 'lint',
      outcome: 'failed',
      isRunning: false,
      at: AT('10:05:00'),
      url: 'https://github.com/acme/widgets/actions/runs/1/job/12',
      sha: '0123456',
    })
  })

  const FAILURES: [string, Obj][] = [
    ['a failed check run', checkRun('x', 'COMPLETED', 'FAILURE')],
    ['a cancelled check run', checkRun('x', 'COMPLETED', 'CANCELLED')],
    ['a timed out check run', checkRun('x', 'COMPLETED', 'TIMED_OUT')],
    ['a check run waiting on a person', checkRun('x', 'COMPLETED', 'ACTION_REQUIRED')],
    ['a check run that failed to start', checkRun('x', 'COMPLETED', 'STARTUP_FAILURE')],
    ['a stale check run', checkRun('x', 'COMPLETED', 'STALE')],
    ['a failed commit status', statusContext('x', 'FAILURE')],
    ['a commit status in error', statusContext('x', 'ERROR')],
  ]

  for (const [name, node] of FAILURES) {
    test(`${name} fails the run`, () => {
      expect(ciOf(commit(rollup('FAILURE', [checkRun('ok', 'COMPLETED', 'SUCCESS'), node])))).toMatchObject({
        outcome: 'failed',
        workflow: 'x',
        isRunning: false,
      })
    })
  }

  test('is pending and running while a check runs: the first running one is named, the earliest start is the time', () => {
    const ci = ciOf(
      commit(
        rollup('PENDING', [
          checkRun('build', 'COMPLETED', 'SUCCESS'),
          checkRun('e2e', 'IN_PROGRESS', null, {
            startedAt: '2026-10-07T10:30:00Z',
            detailsUrl: 'https://github.com/acme/widgets/actions/runs/1/job/14',
          }),
          checkRun('docs', 'QUEUED', null, { startedAt: '2026-10-07T10:20:00Z' }),
        ]),
      ),
    )

    expect(ci).toEqual({
      workflow: 'e2e',
      outcome: 'pending',
      isRunning: true,
      at: AT('10:20:00'),
      url: 'https://github.com/acme/widgets/actions/runs/1/job/14',
      sha: '0123456',
    })
  })

  const RUNNING: [string, Obj][] = [
    ['a queued check run', checkRun('x', 'QUEUED', null)],
    ['a check run in progress', checkRun('x', 'IN_PROGRESS', null)],
    ['a waiting check run', checkRun('x', 'WAITING', null)],
    ['a pending check run', checkRun('x', 'PENDING', null)],
    ['a requested check run', checkRun('x', 'REQUESTED', null)],
    ['a check run in progress that holds the conclusion of an earlier run', checkRun('x', 'IN_PROGRESS', 'SUCCESS')],
    ['a pending commit status', statusContext('x', 'PENDING')],
    ['an expected commit status', statusContext('x', 'EXPECTED')],
  ]

  for (const [name, node] of RUNNING) {
    test(`${name} is running`, () => {
      expect(ciOf(commit(rollup('PENDING', [checkRun('ok', 'COMPLETED', 'SUCCESS'), node])))).toMatchObject({
        outcome: 'pending',
        workflow: 'x',
        isRunning: true,
      })
    })
  }

  test('stays failed while another check runs, and says so: failed and running', () => {
    const ci = ciOf(
      commit(
        rollup('FAILURE', [
          checkRun('lint', 'COMPLETED', 'FAILURE', {
            detailsUrl: 'https://github.com/acme/widgets/actions/runs/1/job/12',
          }),
          checkRun('e2e', 'IN_PROGRESS', null, { startedAt: '2026-10-07T10:30:00Z' }),
        ]),
      ),
    )

    expect(ci).toMatchObject({
      outcome: 'failed',
      isRunning: true,
      workflow: 'lint',
      url: 'https://github.com/acme/widgets/actions/runs/1/job/12',
      at: AT('10:30:00'),
    })
  })

  test('is skipped when every check was skipped or neutral, and passed when one passed', () => {
    const skipped = checkRun('docs', 'COMPLETED', 'SKIPPED')
    const neutral = checkRun('notes', 'COMPLETED', 'NEUTRAL')

    expect(ciOf(commit(rollup('SUCCESS', [skipped])))).toMatchObject({
      outcome: 'skipped',
      isRunning: false,
      workflow: '',
    })
    expect(ciOf(commit(rollup('SUCCESS', [skipped, neutral])))).toMatchObject({ outcome: 'skipped' })
    expect(ciOf(commit(rollup('SUCCESS', [skipped, checkRun('build', 'COMPLETED', 'SUCCESS')])))).toMatchObject({
      outcome: 'passed',
    })
  })

  test('counts a check once, by its newest run: a re-run replaces the run it follows, in either order', () => {
    const failedFirst = checkRun('test', 'COMPLETED', 'FAILURE', { startedAt: '2026-10-07T09:00:00Z' })
    const passedAfter = checkRun('test', 'COMPLETED', 'SUCCESS', { startedAt: '2026-10-07T11:00:00Z' })

    expect(ciOf(commit(rollup('SUCCESS', [failedFirst, passedAfter])))).toMatchObject({ outcome: 'passed' })
    expect(ciOf(commit(rollup('SUCCESS', [passedAfter, failedFirst])))).toMatchObject({ outcome: 'passed' })

    const passedFirst = checkRun('test', 'COMPLETED', 'SUCCESS', { startedAt: '2026-10-07T09:00:00Z' })
    const failedAfter = checkRun('test', 'COMPLETED', 'FAILURE', { startedAt: '2026-10-07T11:00:00Z' })

    expect(ciOf(commit(rollup('FAILURE', [passedFirst, failedAfter])))).toMatchObject({
      outcome: 'failed',
      workflow: 'test',
    })
    expect(ciOf(commit(rollup('FAILURE', [failedAfter, passedFirst])))).toMatchObject({
      outcome: 'failed',
      workflow: 'test',
    })
  })

  test('takes a re-run that has not started yet as the newest run of its check', () => {
    const failed = checkRun('test', 'COMPLETED', 'FAILURE', { startedAt: '2026-10-07T09:00:00Z' })
    const queued = checkRun('test', 'QUEUED', null, { startedAt: null })

    for (const nodes of [
      [failed, queued],
      [queued, failed],
    ]) {
      expect(ciOf(commit(rollup('PENDING', nodes)))).toMatchObject({
        outcome: 'pending',
        isRunning: true,
        workflow: 'test',
      })
    }
  })

  test('says 0 when a running check has no start time, or the time it is given', () => {
    const nodes = [checkRun('e2e', 'QUEUED', null, { startedAt: null })]

    expect(ciOf(commit(rollup('PENDING', nodes)))?.at).toBe(0)
    expect(ciOf(commit(rollup('PENDING', nodes)), AT('11:00:00'))?.at).toBe(AT('11:00:00'))
    expect(ciOf(commit(rollup('PENDING', nodes)), Number.NaN)?.at).toBe(0)
    expect(ciOf(commit(rollup('PENDING', nodes)), Number.POSITIVE_INFINITY)?.at).toBe(0)
    // A run with a known start keeps it, whatever the time given.
    expect(ciOf(commit(rollup('PENDING', [checkRun('e2e', 'QUEUED', null)])), AT('11:00:00'))?.at).toBe(AT('10:00:00'))
  })

  test('says 0 when nothing says when a finished run ended, and ignores the time a run was never given', () => {
    const none = checkRun('build', 'COMPLETED', 'SUCCESS', { completedAt: null })
    const zero = checkRun('lint', 'COMPLETED', 'SUCCESS', { completedAt: '0001-01-01T00:00:00Z' })

    expect(ciOf(commit(rollup('SUCCESS', [none])))?.at).toBe(0)
    expect(ciOf(commit(rollup('SUCCESS', [zero])))?.at).toBe(0)
    expect(ciOf(commit(rollup('SUCCESS', [zero, checkRun('test', 'COMPLETED', 'SUCCESS')])), AT('12:00:00'))?.at).toBe(
      AT('10:05:00'),
    )
    expect(
      ciOf(commit(rollup('SUCCESS', [checkRun('build', 'COMPLETED', 'SUCCESS', { completedAt: 'yesterday' })])))?.at,
    ).toBe(0)
  })

  test('reads a commit status by its context, its creation time and its link', () => {
    expect(
      ciOf(
        commit(
          rollup('FAILURE', [
            statusContext('ci/legacy', 'FAILURE', {
              createdAt: '2026-10-07T10:40:00Z',
              targetUrl: 'https://ci.example.com/9',
            }),
          ]),
        ),
      ),
    ).toEqual({
      workflow: 'ci/legacy',
      outcome: 'failed',
      isRunning: false,
      at: AT('10:40:00'),
      url: 'https://ci.example.com/9',
      sha: '0123456',
    })
    expect(
      ciOf(commit(rollup('PENDING', [statusContext('ci/legacy', 'PENDING', { createdAt: '2026-10-07T10:41:00Z' })]))),
    ).toMatchObject({
      outcome: 'pending',
      isRunning: true,
      at: AT('10:41:00'),
      url: 'https://ci.example.com/7',
    })
  })

  test('tells a commit status from a check run by its fields when it has no type', () => {
    expect(ciOf(commit(rollup('FAILURE', [{ context: 'ci/legacy', state: 'FAILURE' }])))).toMatchObject({
      outcome: 'failed',
      workflow: 'ci/legacy',
    })
    expect(
      ciOf(commit(rollup('FAILURE', [{ name: 'build', status: 'COMPLETED', conclusion: 'FAILURE' }]))),
    ).toMatchObject({
      outcome: 'failed',
      workflow: 'build',
    })
  })

  test('takes what it cannot read as pending, never as passed, and not as running', () => {
    for (const node of [
      checkRun('x', 'COMPLETED', 'SOMETHING_NEW'),
      checkRun('x', 'COMPLETED', null),
      checkRun('x', 'SOMETHING_NEW', null),
      checkRun('x', '', null),
      statusContext('x', 'SOMETHING_NEW'),
      statusContext('x', ''),
    ]) {
      expect(ciOf(commit(rollup('SUCCESS', [checkRun('ok', 'COMPLETED', 'SUCCESS'), node])))).toMatchObject({
        outcome: 'pending',
        isRunning: false,
        workflow: '',
      })
    }
  })

  test('reads a status in any case, as another gh might print it', () => {
    expect(ciOf(commit(rollup('SUCCESS', [checkRun('x', 'completed', 'success')])))).toMatchObject({
      outcome: 'passed',
    })
    expect(ciOf(commit(rollup('FAILURE', [checkRun('x', '', 'FAILURE')])))).toMatchObject({ outcome: 'failed' })
  })

  test('is null when the commit has no checks, and for anything that is not a commit', () => {
    for (const value of [
      commit(null),
      commit(undefined),
      commit({}),
      { oid: SHA },
      { statusCheckRollup: [] },
      {},
      null,
      undefined,
      5,
      'x',
      [],
      true,
    ]) {
      expect(ciOf(value)).toBeNull()
    }
  })

  test('reads a rollup given by itself the same way, with no commit to name', () => {
    expect(ciOf(rollup('SUCCESS', [checkRun('build', 'COMPLETED', 'SUCCESS')]))).toEqual({
      workflow: '',
      outcome: 'passed',
      isRunning: false,
      at: AT('10:05:00'),
      url: '',
      sha: '',
    })
  })

  test('shortens the commit to seven characters, and leaves it empty when it is not one', () => {
    const roll = rollup('SUCCESS', [checkRun('build', 'COMPLETED', 'SUCCESS')])

    expect(ciOf(commit(roll, 'ABCDEF1234'))?.sha).toBe('ABCDEF1')
    expect(ciOf(commit(roll, '1234567'))?.sha).toBe('1234567')
    for (const oid of ['abc', 'not a sha', '', null, 12345678, `${SHA}${SHA}`]) {
      expect(ciOf({ oid, statusCheckRollup: roll })?.sha).toBe('')
    }
  })

  test('leaves out a check with no name, and what is not a check', () => {
    const nodes = [null, 5, 'x', [], {}, checkRun('', 'COMPLETED', 'FAILURE'), checkRun('ok', 'COMPLETED', 'SUCCESS')]

    expect(ciOf(commit(rollup('SUCCESS', nodes)))).toMatchObject({ outcome: 'passed', workflow: '' })
    // Nothing left to read: the rollup's own state, or no CI when it says none either.
    expect(ciOf(commit(rollup('SUCCESS', [null, 5, {}])))).toMatchObject({ outcome: 'passed', isRunning: false })
    expect(ciOf(commit(rollup('', [null, 5, {}])))).toBeNull()
  })

  test('adds what the rollup says when there are more checks than were read: a failure beyond the first fifty counts', () => {
    const passing = [checkRun('build', 'COMPLETED', 'SUCCESS'), checkRun('test', 'COMPLETED', 'SUCCESS')]

    expect(ciOf(commit(rollup('FAILURE', passing, 120)))).toMatchObject({
      outcome: 'failed',
      workflow: '',
      url: '',
      isRunning: false,
    })
    expect(ciOf(commit(rollup('ERROR', passing, 120)))).toMatchObject({ outcome: 'failed' })
    expect(ciOf(commit(rollup('PENDING', passing, 120)))).toMatchObject({ outcome: 'pending', isRunning: false })
    expect(ciOf(commit(rollup('SUCCESS', passing, 120)))).toMatchObject({ outcome: 'passed' })
    // A failure read stays a failure, and a wait does not hide one.
    expect(ciOf(commit(rollup('PENDING', [checkRun('lint', 'COMPLETED', 'FAILURE')], 120)))).toMatchObject({
      outcome: 'failed',
      workflow: 'lint',
    })
  })

  test('trusts the checks it read when it read them all, whatever the rollup says', () => {
    const passing = [checkRun('build', 'COMPLETED', 'SUCCESS')]

    expect(ciOf(commit(rollup('FAILURE', passing, 1)))).toMatchObject({ outcome: 'passed' })
    expect(ciOf(commit(rollup('FAILURE', passing)))).toMatchObject({ outcome: 'passed' })
  })

  test('reads the rollup alone when there is no check to read', () => {
    expect(ciOf(commit(rollup('SUCCESS', [])))).toMatchObject({ outcome: 'passed', isRunning: false, at: 0 })
    expect(ciOf(commit(rollup('FAILURE', [])))).toMatchObject({ outcome: 'failed' })
    expect(ciOf(commit(rollup('PENDING', [])))).toMatchObject({ outcome: 'pending', isRunning: false })
    expect(ciOf(commit(rollup('', [])))).toBeNull()
    expect(ciOf(commit(rollup('SOMETHING_NEW', [])))).toBeNull()
  })

  test('cleans a name and refuses an unsafe link', () => {
    const ci = ciOf(
      commit(
        rollup('FAILURE', [
          checkRun('  lint\u202e / \u001b[31mfast\u0007\n', 'COMPLETED', 'FAILURE', {
            detailsUrl: 'javascript:alert(1)',
          }),
        ]),
      ),
    )

    expect(ci?.workflow).toBe('lint / fast')
    expect(ci?.url).toBe('')
    expect(
      ciOf(commit(rollup('FAILURE', [statusContext('ci', 'FAILURE', { targetUrl: 'ftp://example.com/x' })])))?.url,
    ).toBe('')
  })

  test('does not change what it is given', () => {
    const given = commit(
      rollup('FAILURE', [checkRun('a', 'COMPLETED', 'FAILURE'), checkRun('a', 'COMPLETED', 'SUCCESS')]),
    )
    const before = json(given)

    ciOf(given, 5)
    expect(json(given)).toBe(before)
  })
})

// ---------------------------------------------------------------- fixtures: an answer

/** What GitHub printed for the branch's head commit: a failed check (re-run once and then passing), a running one, a skipped one. */
const BRANCH_CHECKS: Obj[] = [
  checkRun('build', 'COMPLETED', 'SUCCESS', {
    startedAt: '2026-10-07T10:00:00Z',
    completedAt: '2026-10-07T10:05:00Z',
    detailsUrl: 'https://github.com/acme/widgets/actions/runs/1/job/11',
  }),
  checkRun('lint', 'COMPLETED', 'FAILURE', {
    startedAt: '2026-10-07T10:00:10Z',
    completedAt: '2026-10-07T10:02:00Z',
    detailsUrl: 'https://github.com/acme/widgets/actions/runs/1/job/12',
  }),
  checkRun('test', 'COMPLETED', 'FAILURE', {
    startedAt: '2026-10-07T09:00:00Z',
    completedAt: '2026-10-07T09:10:00Z',
    detailsUrl: 'https://github.com/acme/widgets/actions/runs/0/job/9',
  }),
  checkRun('test', 'COMPLETED', 'SUCCESS', {
    startedAt: '2026-10-07T10:00:20Z',
    completedAt: '2026-10-07T10:20:00Z',
    detailsUrl: 'https://github.com/acme/widgets/actions/runs/1/job/13',
  }),
  checkRun('e2e', 'IN_PROGRESS', null, {
    startedAt: '2026-10-07T10:21:00Z',
    detailsUrl: 'https://github.com/acme/widgets/actions/runs/1/job/14',
  }),
  checkRun('docs', 'COMPLETED', 'SKIPPED', { startedAt: '2026-10-07T10:00:30Z', completedAt: '2026-10-07T10:00:31Z' }),
  statusContext('deploy/preview', 'PENDING', {
    createdAt: '2026-10-07T10:22:00Z',
    targetUrl: 'https://ci.example.com/7',
  }),
]

const CLOSING_123: Obj = {
  number: 123,
  title: 'Cache the widgets',
  state: 'OPEN',
  url: 'https://github.com/acme/widgets/issues/123',
  repository: { nameWithOwner: 'acme/widgets' },
}
const CLOSING_ELSEWHERE: Obj = {
  number: 7,
  title: 'Polish the gadget',
  state: 'OPEN',
  url: 'https://github.com/acme/gadgets/issues/7',
  repository: { nameWithOwner: 'acme/gadgets' },
}

/** The branch's pull request as the `head` selection prints it. */
const HEAD_PR: Obj = {
  number: 42,
  title: 'Add the widget cache',
  url: 'https://github.com/acme/widgets/pull/42',
  isDraft: false,
  reviewDecision: 'CHANGES_REQUESTED',
  author: { login: 'alice' },
  headRefName: 'feat/123-widget-cache',
  updatedAt: '2026-10-07T10:06:00Z',
  state: 'OPEN',
  isCrossRepository: false,
  mergeStateStatus: 'BEHIND',
  autoMergeRequest: { enabledAt: '2026-10-07T09:30:00Z' },
  reviewRequests: {
    nodes: [
      { requestedReviewer: { __typename: 'User', login: 'bob' } },
      { requestedReviewer: { __typename: 'Team', slug: 'platform' } },
    ],
  },
  latestReviews: {
    nodes: [
      { state: 'CHANGES_REQUESTED', author: { login: 'carol' } },
      { state: 'COMMENTED', author: { login: 'bob' } },
    ],
  },
  closingIssuesReferences: { nodes: [CLOSING_123, CLOSING_ELSEWHERE] },
  statusCheckRollup: rollup('FAILURE', BRANCH_CHECKS),
}

/** A row of the board or the review queue as the `Pr` fragment prints it. */
function row(number: number, change: Obj = {}): Obj {
  return {
    number,
    title: `Row ${number}`,
    url: `https://github.com/acme/widgets/pull/${number}`,
    isDraft: false,
    reviewDecision: 'REVIEW_REQUIRED',
    author: { login: 'bob' },
    headRefName: `feat/${number}-x`,
    updatedAt: '2026-10-06T08:00:00Z',
    ...change,
  }
}

const TEAM: Obj[] = [
  {
    ...row(42, {
      title: 'Add the widget cache',
      author: { login: 'alice' },
      headRefName: 'feat/123-widget-cache',
      reviewDecision: 'CHANGES_REQUESTED',
      updatedAt: '2026-10-07T10:06:00Z',
    }),
    closingIssuesReferences: { nodes: [{ number: 123, repository: { nameWithOwner: 'acme/widgets' } }] },
  },
  {
    ...row(70, { title: 'Add the audit log', headRefName: 'feat/70-audit-log', reviewDecision: 'APPROVED' }),
    closingIssuesReferences: {
      nodes: [
        { number: 401, repository: { nameWithOwner: 'acme/widgets' } },
        { number: 9, repository: { nameWithOwner: 'acme/gadgets' } },
      ],
    },
  },
  {
    ...row(71, {
      title: 'New billing page',
      author: { login: 'carol' },
      headRefName: 'feat/71-billing',
      isDraft: true,
      reviewDecision: null,
    }),
    closingIssuesReferences: { nodes: [] },
  },
  {
    ...row(72, { title: 'Bump the toolchain', author: { login: 'dave' }, headRefName: 'chore/toolchain' }),
    closingIssuesReferences: { nodes: [] },
  },
]

const REVIEW: Obj[] = [
  row(88, {
    title: 'Bump the gadget kit',
    url: 'https://github.com/acme/gadgets/pull/88',
    author: { login: 'erin' },
    headRefName: 'chore/kit',
  }),
  row(75, {
    title: 'Cache the session list',
    author: { login: 'dave' },
    headRefName: 'feat/75-sessions',
    isDraft: true,
    reviewDecision: null,
  }),
]

const ASSIGNED: Obj[] = [
  {
    number: 130,
    title: 'Flaky end-to-end test',
    url: 'https://github.com/acme/widgets/issues/130',
    updatedAt: '2026-10-05T12:00:00Z',
    closedByPullRequestsReferences: { nodes: [] },
  },
  {
    number: 123,
    title: 'Cache the widgets',
    url: 'https://github.com/acme/widgets/issues/123',
    updatedAt: '2026-10-06T09:00:00Z',
    closedByPullRequestsReferences: { nodes: [{ number: 42 }] },
  },
  {
    number: 12,
    title: 'Gadget docs',
    url: 'https://github.com/acme/gadgets/issues/12',
    updatedAt: '2026-10-04T09:00:00Z',
    closedByPullRequestsReferences: { nodes: [] },
  },
]

const REPOSITORY: Obj = {
  nameWithOwner: 'acme/widgets',
  defaultBranchRef: {
    name: 'main',
    target: commit(
      rollup('SUCCESS', [
        checkRun('build', 'COMPLETED', 'SUCCESS', {
          startedAt: '2026-10-07T07:50:00Z',
          completedAt: '2026-10-07T08:00:00Z',
        }),
      ]),
      DEFAULT_SHA,
    ),
  },
  branch: { target: commit(rollup('FAILURE', BRANCH_CHECKS)) },
  head: { nodes: [HEAD_PR] },
  team: { totalCount: 12, nodes: TEAM },
  r123: {
    __typename: 'Issue',
    number: 123,
    title: 'Cache the widgets',
    state: 'OPEN',
    url: 'https://github.com/acme/widgets/issues/123',
  },
  r124: { __typename: 'PullRequest', number: 124 },
  r45: {
    __typename: 'Issue',
    number: 45,
    title: 'Fix the crash',
    state: 'CLOSED',
    url: 'https://github.com/acme/widgets/issues/45',
  },
}

const DATA: Obj = {
  viewer: { login: 'octocat' },
  rateLimit: { cost: 1, remaining: 4990, resetAt: '2026-10-07T13:00:00Z' },
  repository: REPOSITORY,
  review: { issueCount: 2, nodes: REVIEW },
  assigned: { issueCount: 3, nodes: ASSIGNED },
}

/** The refs the lane passes for this branch: its name, a commit that mentions a pull request, a commit that mentions an issue. */
const REFS: TicketNumber[] = [
  { number: 123, source: 'branch' },
  { number: 124, source: 'commit' },
  { number: 45, source: 'commit' },
]

/** A whole answer, with parts of it replaced; a value of `undefined` leaves the key out, as GraphQL does for what it was not asked. */
function answer(change: { data?: Obj; repository?: Obj; errors?: unknown[] } = {}): Obj {
  const body: Obj = { data: { ...DATA, ...change.data, repository: { ...REPOSITORY, ...change.repository } } }

  if (change.errors !== undefined) {
    body.errors = change.errors
  }

  return body
}

/** What a lane gets from an answer that was read. */
function dataOf(body: unknown, change: Partial<QueryInput> = {}, exitCode = 0): GithubData {
  const result = parseAnswer(json(body), exitCode, '', ask({ refs: REFS, ...change }))

  if (result.kind !== 'ok') {
    throw new Error(`expected an answer that was read, got ${json(result)}`)
  }

  return result.data
}

const EXPECTED_PR: PullRequest = {
  number: 42,
  title: 'Add the widget cache',
  url: 'https://github.com/acme/widgets/pull/42',
  author: 'alice',
  branch: 'feat/123-widget-cache',
  isDraft: false,
  review: 'changes_requested',
  reviewers: ['bob', '@platform'],
  reviews: [
    { author: 'carol', state: 'changes_requested' },
    { author: 'bob', state: 'commented' },
  ],
  checks: [
    { name: 'build', outcome: 'passed' },
    { name: 'lint', outcome: 'failed' },
    { name: 'test', outcome: 'passed' },
    { name: 'e2e', outcome: 'pending' },
    { name: 'docs', outcome: 'skipped' },
    { name: 'deploy/preview', outcome: 'pending' },
  ],
  merge: 'behind',
  isAutoMerge: true,
  closes: [123],
  updatedAt: '2026-10-07T10:06:00Z',
}

const EXPECTED_CI: CiRun = {
  workflow: 'lint',
  outcome: 'failed',
  isRunning: true,
  at: AT('10:21:00'),
  url: 'https://github.com/acme/widgets/actions/runs/1/job/12',
  sha: '0123456',
}

const EXPECTED_TICKETS: IssueRef[] = [
  {
    number: 123,
    title: 'Cache the widgets',
    state: 'open',
    url: 'https://github.com/acme/widgets/issues/123',
    labels: [],
    assignees: [],
    source: 'pr',
  },
  {
    number: 45,
    title: 'Fix the crash',
    state: 'closed',
    url: 'https://github.com/acme/widgets/issues/45',
    labels: [],
    assignees: [],
    source: 'commit',
  },
]

/** A row of a list: no checks, no review texts, no merge state. */
function listed(number: number, change: Partial<PullRequest>): PullRequest {
  return {
    number,
    title: `Row ${number}`,
    url: `https://github.com/acme/widgets/pull/${number}`,
    author: 'bob',
    branch: `feat/${number}-x`,
    isDraft: false,
    review: 'pending',
    reviewers: [],
    reviews: [],
    checks: [],
    merge: 'unknown',
    isAutoMerge: false,
    closes: [],
    updatedAt: '2026-10-06T08:00:00Z',
    ...change,
  }
}

const EXPECTED_BOARD: PullRequest[] = [
  listed(70, { title: 'Add the audit log', branch: 'feat/70-audit-log', review: 'approved', closes: [401] }),
  listed(71, {
    title: 'New billing page',
    author: 'carol',
    branch: 'feat/71-billing',
    isDraft: true,
    review: 'draft',
    merge: 'draft',
  }),
  listed(72, { title: 'Bump the toolchain', author: 'dave', branch: 'chore/toolchain' }),
]

const EXPECTED_QUEUE: PullRequest[] = [
  listed(88, {
    title: 'Bump the gadget kit',
    url: 'https://github.com/acme/gadgets/pull/88',
    author: 'erin',
    branch: 'chore/kit',
  }),
  listed(75, {
    title: 'Cache the session list',
    author: 'dave',
    branch: 'feat/75-sessions',
    isDraft: true,
    review: 'draft',
    merge: 'draft',
  }),
]

const EXPECTED_ASSIGNED: Issue[] = [
  {
    number: 130,
    title: 'Flaky end-to-end test',
    url: 'https://github.com/acme/widgets/issues/130',
    assignees: [],
    labels: [],
    updatedAt: '2026-10-05T12:00:00Z',
    inPr: null,
  },
  {
    number: 123,
    title: 'Cache the widgets',
    url: 'https://github.com/acme/widgets/issues/123',
    assignees: [],
    labels: [],
    updatedAt: '2026-10-06T09:00:00Z',
    inPr: 42,
  },
  {
    number: 12,
    title: 'Gadget docs',
    url: 'https://github.com/acme/gadgets/issues/12',
    assignees: [],
    labels: [],
    updatedAt: '2026-10-04T09:00:00Z',
    inPr: null,
  },
]

// ---------------------------------------------------------------- the answer

describe('parseAnswer: an answer that was read', () => {
  test('reads everything one call brings: the branch, its CI, the tickets, the three lists and their counts', () => {
    const result = parseAnswer(json(answer()), 0, '', ask({ refs: REFS }))

    expect(result).toEqual({
      kind: 'ok',
      resetAtMs: Date.parse('2026-10-07T13:00:00Z'),
      data: {
        repo: 'acme/widgets',
        viewer: 'octocat',
        defaultBranch: 'main',
        defaultCi: { workflow: '', outcome: 'passed', isRunning: false, at: AT('08:00:00'), url: '', sha: 'a1b2c3d' },
        pr: EXPECTED_PR,
        ci: EXPECTED_CI,
        tickets: EXPECTED_TICKETS,
        board: EXPECTED_BOARD,
        reviewQueue: EXPECTED_QUEUE,
        assigned: EXPECTED_ASSIGNED,
        totals: { board: 12, reviewQueue: 2, assigned: 3 },
      },
    })
  })

  test('leaves the lists and their counts null when the pane is closed, whatever the data holds', () => {
    const closed = answer({ data: { review: undefined, assigned: undefined }, repository: { team: undefined } })
    const without = dataOf(closed, { lists: false })

    expect(without.board).toBeNull()
    expect(without.reviewQueue).toBeNull()
    expect(without.assigned).toBeNull()
    expect(without.totals).toBeNull()
    // The branch's side is there all the same.
    expect(without.pr).toEqual(EXPECTED_PR)
    expect(without.ci).toEqual(EXPECTED_CI)
    expect(without.tickets).toEqual(EXPECTED_TICKETS)

    // An answer that carries lists nobody asked for (a stale cache) is not read as having them.
    const stale = dataOf(answer(), { lists: false })

    expect(stale.board).toBeNull()
    expect(stale.totals).toBeNull()
  })

  test('folds the re-runs of a check: one entry per name, the newest run, in the order the names first appear', () => {
    expect(dataOf(answer()).pr?.checks).toEqual(EXPECTED_PR.checks)

    const reversed = answer({
      repository: {
        head: { nodes: [{ ...HEAD_PR, statusCheckRollup: rollup('FAILURE', [...BRANCH_CHECKS].reverse()) }] },
      },
    })

    // Newest wins whichever comes first; only the order of the names follows the list.
    expect(dataOf(reversed).pr?.checks.find(check => check.name === 'test')).toEqual({
      name: 'test',
      outcome: 'passed',
    })
    expect(dataOf(reversed).pr?.checks.map(check => check.name)).toEqual([
      'deploy/preview',
      'docs',
      'e2e',
      'test',
      'lint',
      'build',
    ])
  })

  test('names the reviewers still asked: people by login, teams as @slug, bots and mannequins by login', () => {
    const asked = {
      nodes: [
        { requestedReviewer: { __typename: 'User', login: 'bob' } },
        { requestedReviewer: { __typename: 'Team', slug: 'platform' } },
        { requestedReviewer: { __typename: 'Bot', login: 'review-helper' } },
        { requestedReviewer: { __typename: 'Mannequin', login: 'imported-erin' } },
        { requestedReviewer: { __typename: 'User', login: 'bob' } },
        { requestedReviewer: null },
        { requestedReviewer: { __typename: 'Team' } },
        { requestedReviewer: {} },
        null,
      ],
    }

    expect(
      dataOf(answer({ repository: { head: { nodes: [{ ...HEAD_PR, reviewRequests: asked }] } } })).pr?.reviewers,
    ).toEqual(['bob', '@platform', 'review-helper', 'imported-erin'])
  })

  test('reads the latest review of each reviewer, and names a deleted account as GitHub does', () => {
    const reviews = {
      nodes: [
        { state: 'APPROVED', author: { login: 'alice' } },
        { state: 'CHANGES_REQUESTED', author: { login: 'alice' } },
        { state: 'DISMISSED', author: { login: 'bob' } },
        { state: 'PENDING', author: { login: 'carol' } },
        { state: 'SOMETHING_NEW', author: { login: 'dave' } },
        { state: 'APPROVED', author: null },
      ],
    }

    expect(
      dataOf(answer({ repository: { head: { nodes: [{ ...HEAD_PR, latestReviews: reviews }] } } })).pr?.reviews,
    ).toEqual([
      { author: 'alice', state: 'approved' },
      { author: 'bob', state: 'dismissed' },
      { author: 'carol', state: 'pending' },
      { author: 'ghost', state: 'approved' },
    ])
  })

  const DECISIONS: [unknown, boolean, string | null, string][] = [
    ['APPROVED', false, 'approved', 'clean'],
    ['CHANGES_REQUESTED', false, 'changes_requested', 'dirty'],
    ['REVIEW_REQUIRED', false, 'pending', 'blocked'],
    [null, false, null, 'unstable'],
    ['SOMETHING_NEW', false, null, 'unknown'],
    ['APPROVED', true, 'draft', 'draft'],
    [null, true, 'draft', 'draft'],
  ]

  for (const [decision, isDraft, review, merge] of DECISIONS) {
    test(`maps the decision ${JSON.stringify(decision)}${isDraft ? ' on a draft' : ''} to ${review ?? 'none'}, and its merge state to ${merge}`, () => {
      const status = {
        clean: 'CLEAN',
        dirty: 'DIRTY',
        blocked: 'BLOCKED',
        unstable: 'UNSTABLE',
        unknown: 'WHATEVER',
        draft: 'BLOCKED',
      }[merge]
      const node = { ...HEAD_PR, reviewDecision: decision, isDraft, mergeStateStatus: status }
      const pr = dataOf(answer({ repository: { head: { nodes: [node] } } })).pr

      expect(pr?.review).toBe(review)
      expect(pr?.merge).toBe(merge)
      expect(pr?.isDraft).toBe(isDraft)
    })
  }

  test('maps every merge state GitHub defines', () => {
    const CASES: [string, string][] = [
      ['CLEAN', 'clean'],
      ['BEHIND', 'behind'],
      ['DIRTY', 'dirty'],
      ['BLOCKED', 'blocked'],
      ['UNSTABLE', 'unstable'],
      ['HAS_HOOKS', 'clean'],
      ['DRAFT', 'draft'],
      ['UNKNOWN', 'unknown'],
      ['', 'unknown'],
    ]

    for (const [status, merge] of CASES) {
      const pr = dataOf(answer({ repository: { head: { nodes: [{ ...HEAD_PR, mergeStateStatus: status }] } } })).pr

      expect(pr?.merge).toBe(merge)
    }
  })

  test('reads auto-merge from its request being there', () => {
    const autoMerge = (value: unknown): boolean | undefined =>
      dataOf(answer({ repository: { head: { nodes: [{ ...HEAD_PR, autoMergeRequest: value }] } } })).pr?.isAutoMerge

    expect(autoMerge(null)).toBe(false)
    expect(autoMerge(undefined)).toBe(false)
    expect(autoMerge({ enabledAt: '2026-10-07T09:30:00Z' })).toBe(true)
  })

  test('has no review state for a repository that asks for no review', () => {
    const quiet = {
      ...HEAD_PR,
      reviewDecision: null,
      reviewRequests: { nodes: [] },
      latestReviews: { nodes: [] },
      statusCheckRollup: null,
    }
    const pr = dataOf(answer({ repository: { head: { nodes: [quiet] } } })).pr

    expect(pr).toMatchObject({ review: null, reviewers: [], reviews: [], checks: [] })
  })

  test('skips a ticket number that names nothing, and keeps everything else: NOT_FOUND with data, on exit 1', () => {
    const body = answer({
      repository: { r45: null },
      errors: [
        {
          type: 'NOT_FOUND',
          path: ['repository', 'r45'],
          locations: [{ line: 28, column: 148 }],
          message: 'Could not resolve to an issue or pull request with the number of 45.',
        },
      ],
    })
    const result = parseAnswer(
      json(body),
      1,
      'gh: Could not resolve to an issue or pull request with the number of 45.',
      ask({ refs: REFS }),
    )

    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      expect(result.data.tickets).toEqual([EXPECTED_TICKETS[0]])
      expect(result.data.pr).toEqual(EXPECTED_PR)
      expect(result.data.ci).toEqual(EXPECTED_CI)
      expect(result.data.board).toEqual(EXPECTED_BOARD)
      expect(result.data.assigned).toEqual(EXPECTED_ASSIGNED)
      expect(result.resetAtMs).toBe(Date.parse('2026-10-07T13:00:00Z'))
    }
  })

  test('skips several numbers that name nothing at once', () => {
    const missing = (n: number): Obj => ({
      type: 'NOT_FOUND',
      path: ['repository', `r${n}`],
      message: `Could not resolve ${n}.`,
    })
    const body = answer({ repository: { r45: null, r124: null }, errors: [missing(45), missing(124)] })

    expect(dataOf(body, {}, 1).tickets).toEqual([EXPECTED_TICKETS[0]])
  })

  test('does not take a pull request for a ticket', () => {
    const tickets = dataOf(answer(), { refs: [{ number: 124, source: 'commit' }] }).tickets

    expect(tickets).toEqual([EXPECTED_TICKETS[0]])
    expect(tickets.some(ticket => ticket.number === 124)).toBe(false)
  })

  test('puts what the pull request closes first, then the numbers looked up that are issues, each once', () => {
    // 123 is closed by the pull request and named by the branch: the pull request's word stands, and the source is "pr".
    const tickets = dataOf(answer()).tickets

    expect(tickets.map(ticket => [ticket.number, ticket.source])).toEqual([
      [123, 'pr'],
      [45, 'commit'],
    ])
  })

  test('reads only the lookups it asked for', () => {
    // The data holds r123, r124 and r45; nothing was asked for but the pull request's own closing issue.
    expect(dataOf(answer(), { refs: [] }).tickets).toEqual([EXPECTED_TICKETS[0]])
    expect(
      dataOf(answer(), { refs: [{ number: 45, source: 'branch' }] }).tickets.map(ticket => [
        ticket.number,
        ticket.source,
      ]),
    ).toEqual([
      [123, 'pr'],
      [45, 'branch'],
    ])
  })

  test('keeps the source each lookup was asked with', () => {
    const body = answer({
      repository: {
        head: { nodes: [{ ...HEAD_PR, closingIssuesReferences: { nodes: [] } }] },
        r123: {
          __typename: 'Issue',
          number: 123,
          title: 'Cache the widgets',
          state: 'OPEN',
          url: 'https://github.com/acme/widgets/issues/123',
        },
      },
    })

    expect(dataOf(body).tickets.map(ticket => [ticket.number, ticket.source])).toEqual([
      [123, 'branch'],
      [45, 'commit'],
    ])
  })

  test('gives at most five tickets, those of the pull request first', () => {
    const refs: TicketNumber[] = [1, 2, 3, 4, 5].map(number => ({ number, source: 'commit' }))
    const issues = Object.fromEntries(
      refs.map(ref => [
        `r${ref.number}`,
        {
          __typename: 'Issue',
          number: ref.number,
          title: `Issue ${ref.number}`,
          state: 'OPEN',
          url: `https://github.com/acme/widgets/issues/${ref.number}`,
        },
      ]),
    )
    const closing = { nodes: [CLOSING_123, { ...CLOSING_123, number: 124, title: 'Another' }] }
    const body = answer({
      repository: { ...issues, head: { nodes: [{ ...HEAD_PR, closingIssuesReferences: closing }] } },
    })
    const tickets = dataOf(body, { refs }).tickets

    expect(tickets.map(ticket => ticket.number)).toEqual([123, 124, 1, 2, 3])
    expect(tickets.map(ticket => ticket.source)).toEqual(['pr', 'pr', 'commit', 'commit', 'commit'])
  })

  test('reads a closed issue and an unknown state', () => {
    const state = (value: unknown): string | undefined =>
      dataOf(
        answer({ repository: { r45: { __typename: 'Issue', number: 45, title: 'x', state: value, url: '' } } }),
      ).tickets.find(ticket => ticket.number === 45)?.state

    expect(state('CLOSED')).toBe('closed')
    expect(state('OPEN')).toBe('open')
    expect(state('SOMETHING_NEW')).toBe('')
    expect(state(null)).toBe('')
  })

  test('picks the open pull request of this repository, then one from a fork, and never one that is not open', () => {
    const own = { ...HEAD_PR, number: 42, isCrossRepository: false }
    const fork = { ...HEAD_PR, number: 43, isCrossRepository: true }
    const merged = { ...HEAD_PR, number: 41, state: 'MERGED', isCrossRepository: false }
    const closed = { ...HEAD_PR, number: 40, state: 'CLOSED', isCrossRepository: false }
    const picked = (nodes: Obj[]): number | undefined => dataOf(answer({ repository: { head: { nodes } } })).pr?.number

    expect(picked([own])).toBe(42)
    expect(picked([fork, own])).toBe(42)
    expect(picked([merged, fork, own])).toBe(42)
    expect(picked([fork])).toBe(43)
    expect(picked([merged, fork])).toBe(43)
    expect(picked([merged, closed])).toBeUndefined()
    expect(picked([merged])).toBeUndefined()
    expect(picked([])).toBeUndefined()
  })

  test('has no pull request, and says so, when the branch has none or none is open', () => {
    for (const head of [
      { nodes: [] },
      { nodes: [{ ...HEAD_PR, state: 'MERGED' }] },
      { nodes: [{ ...HEAD_PR, state: 'CLOSED' }] },
    ]) {
      const data = dataOf(answer({ repository: { head } }))

      expect(data.pr).toBeNull()
      expect(data.ci).toEqual(EXPECTED_CI)
      expect(data.tickets.map(ticket => ticket.number)).toEqual([123, 45])
    }
  })

  test("leaves the branch's own pull request out of the board, wherever it stands, and counts it in the total", () => {
    const later = [...TEAM.slice(1), TEAM[0] ?? {}]
    const data = dataOf(answer({ repository: { team: { totalCount: 12, nodes: later } } }))

    expect(data.board?.map(one => one.number)).toEqual([70, 71, 72])
    expect(data.totals?.board).toBe(12)
    // With no pull request of its own the board is whole.
    expect(dataOf(answer({ repository: { head: { nodes: [] } } })).board?.map(one => one.number)).toEqual([
      42, 70, 71, 72,
    ])
  })

  test('reads the rows of a list with no checks, no review texts and no merge state, as rows', () => {
    const [first] = dataOf(answer()).board ?? []

    expect(first?.checks).toEqual([])
    expect(first?.reviews).toEqual([])
    expect(first?.reviewers).toEqual([])
    expect(first?.merge).toBe('unknown')
    expect(first?.isAutoMerge).toBe(false)
  })

  test('counts only the issues a pull request closes in this repository, in the pull request, its tickets and the board', () => {
    const data = dataOf(answer())

    expect(data.pr?.closes).toEqual([123])
    expect(data.tickets.map(ticket => ticket.number)).not.toContain(7)
    expect(data.board?.find(one => one.number === 70)?.closes).toEqual([401])
  })

  test('compares the repositories in any case, and by the name GitHub gives it now (a renamed repository)', () => {
    const upper = { ...CLOSING_123, repository: { nameWithOwner: 'ACME/Widgets' } }
    const body = answer({
      repository: { head: { nodes: [{ ...HEAD_PR, closingIssuesReferences: { nodes: [upper, CLOSING_ELSEWHERE] } }] } },
    })

    expect(dataOf(body).pr?.closes).toEqual([123])

    // The remote still says widgets-old; GitHub redirects it, and names the repository as it is now.
    const renamed = answer({
      repository: {
        nameWithOwner: 'acme/widgets-next',
        head: {
          nodes: [
            {
              ...HEAD_PR,
              closingIssuesReferences: {
                nodes: [{ ...CLOSING_123, repository: { nameWithOwner: 'acme/widgets-next' } }, CLOSING_ELSEWHERE],
              },
            },
          ],
        },
      },
    })
    const result = dataOf(renamed, { remote: { host: 'github.com', owner: 'acme', name: 'widgets-old' } })

    expect(result.repo).toBe('acme/widgets-next')
    expect(result.pr?.closes).toEqual([123])
    expect(result.tickets[0]).toMatchObject({ number: 123, source: 'pr' })
  })

  test('leaves out an issue that does not say where it is, as one that is elsewhere', () => {
    const nameless = { number: 5, title: 'Where am I', state: 'OPEN', url: 'https://github.com/acme/widgets/issues/5' }
    const body = answer({
      repository: {
        head: {
          nodes: [
            {
              ...HEAD_PR,
              closingIssuesReferences: { nodes: [nameless, { ...nameless, repository: null }, CLOSING_123] },
            },
          ],
        },
      },
    })

    expect(dataOf(body).pr?.closes).toEqual([123])
  })

  test('names the repository by the remote when GitHub does not', () => {
    expect(dataOf(answer({ repository: { nameWithOwner: undefined } })).repo).toBe('acme/widgets')
    expect(dataOf(answer({ repository: { nameWithOwner: 'not a name' } })).repo).toBe('acme/widgets')
  })

  test('reads the assigned issues with the open pull request that closes each', () => {
    const [none, closed, other] = dataOf(answer()).assigned ?? []

    expect(none?.inPr).toBeNull()
    expect(closed?.inPr).toBe(42)
    expect(other?.inPr).toBeNull()
  })

  test('reads an issue assigned to the person that has no pull request field', () => {
    const body = answer({
      data: {
        assigned: {
          issueCount: 1,
          nodes: [{ number: 9, title: 'Bare', url: 'https://github.com/acme/widgets/issues/9' }],
        },
      },
    })

    expect(dataOf(body).assigned).toEqual([
      {
        number: 9,
        title: 'Bare',
        url: 'https://github.com/acme/widgets/issues/9',
        assignees: [],
        labels: [],
        updatedAt: '',
        inPr: null,
      },
    ])
  })

  test('leaves out what is not a pull request or an issue from a list', () => {
    const body = answer({
      data: {
        review: { issueCount: 5, nodes: [row(88), {}, null, 7, { number: 'x' }, { number: 0 }, row(89)] },
        assigned: { issueCount: 4, nodes: [{}, null, { number: 3 }, { number: -1 }] },
      },
    })
    const data = dataOf(body)

    expect(data.reviewQueue?.map(one => one.number)).toEqual([88, 89])
    expect(data.assigned?.map(one => one.number)).toEqual([3])
    expect(data.totals).toEqual({ board: 12, reviewQueue: 5, assigned: 4 })
  })

  test('is null for a list that did not come, and not an empty one; the others stay', () => {
    const body = answer({ data: { review: undefined, assigned: null }, repository: { team: { totalCount: 4 } } })
    const data = dataOf(body)

    expect(data.board).toBeNull()
    expect(data.reviewQueue).toBeNull()
    expect(data.assigned).toBeNull()
    expect(data.totals).toEqual({ board: 4, reviewQueue: 0, assigned: 0 })
    expect(data.pr).toEqual(EXPECTED_PR)
  })

  test('has an empty list when GitHub says there is nothing', () => {
    const body = answer({
      data: { review: { issueCount: 0, nodes: [] }, assigned: { issueCount: 0, nodes: [] } },
      repository: { team: { totalCount: 0, nodes: [] } },
    })
    const data = dataOf(body)

    expect(data.board).toEqual([])
    expect(data.reviewQueue).toEqual([])
    expect(data.assigned).toEqual([])
    expect(data.totals).toEqual({ board: 0, reviewQueue: 0, assigned: 0 })
  })

  test('reads the counts as whole numbers, and 0 for anything else', () => {
    const body = answer({
      data: { review: { issueCount: '2', nodes: [] }, assigned: { issueCount: -1, nodes: [] } },
      repository: { team: { totalCount: 1.5, nodes: [] } },
    })

    expect(dataOf(body).totals).toEqual({ board: 0, reviewQueue: 0, assigned: 0 })
  })

  test('reads the person and the default branch, and nothing of them when absent', () => {
    expect(dataOf(answer({ data: { viewer: null } })).viewer).toBe('')
    expect(dataOf(answer({ repository: { defaultBranchRef: null } }))).toMatchObject({
      defaultBranch: '',
      defaultCi: null,
    })
    expect(dataOf(answer({ repository: { defaultBranchRef: { name: 'trunk', target: {} } } }))).toMatchObject({
      defaultBranch: 'trunk',
      defaultCi: null,
    })
  })

  test('says when the rate limit resets, and null when the answer does not say', () => {
    const result = (data: Obj): number | null | undefined => {
      const answered = parseAnswer(json(answer({ data })), 0, '', ask({ refs: REFS }))

      return answered.kind === 'ok' ? answered.resetAtMs : undefined
    }

    expect(result({})).toBe(Date.parse('2026-10-07T13:00:00Z'))
    expect(result({ rateLimit: undefined })).toBeNull()
    expect(result({ rateLimit: { resetAt: 'soon' } })).toBeNull()
    expect(result({ rateLimit: { resetAt: '0001-01-01T00:00:00Z' } })).toBeNull()
  })

  test('reads a repository that is quiet: no pull request, no CI, no lists', () => {
    const body = {
      data: {
        viewer: { login: 'octocat' },
        rateLimit: { cost: 1, remaining: 4989, resetAt: '2026-10-07T13:00:00Z' },
        repository: {
          nameWithOwner: 'acme/widgets',
          defaultBranchRef: { name: 'main', target: { oid: SHA, statusCheckRollup: null } },
          head: { nodes: [] },
          branch: null,
        },
        review: { issueCount: 0, nodes: [] },
        assigned: { issueCount: 0, nodes: [] },
      },
    }

    expect(dataOf(body, { refs: [] })).toEqual({
      repo: 'acme/widgets',
      viewer: 'octocat',
      defaultBranch: 'main',
      defaultCi: null,
      pr: null,
      ci: null,
      tickets: [],
      board: null,
      reviewQueue: [],
      assigned: [],
      totals: { board: 0, reviewQueue: 0, assigned: 0 },
    })
  })
})

describe('parseAnswer: the CI of the branch and of the default branch', () => {
  const branchCi = (commitValue: unknown): CiRun | null =>
    dataOf(answer({ repository: { branch: { target: commitValue } } })).ci
  const defaultCi = (commitValue: unknown): CiRun | null =>
    dataOf(answer({ repository: { defaultBranchRef: { name: 'main', target: commitValue } } })).defaultCi

  test('is running while a check runs', () => {
    const ci = branchCi(
      commit(
        rollup('PENDING', [
          checkRun('build', 'COMPLETED', 'SUCCESS'),
          checkRun('e2e', 'IN_PROGRESS', null, { startedAt: '2026-10-07T10:30:00Z' }),
        ]),
      ),
    )

    expect(ci).toMatchObject({
      outcome: 'pending',
      isRunning: true,
      workflow: 'e2e',
      at: AT('10:30:00'),
      sha: '0123456',
    })
  })

  test('is failed when a check failed', () => {
    expect(branchCi(commit(rollup('FAILURE', [checkRun('lint', 'COMPLETED', 'FAILURE')])))).toMatchObject({
      outcome: 'failed',
      isRunning: false,
      workflow: 'lint',
    })
  })

  test('is passed when every check passed', () => {
    expect(branchCi(commit(rollup('SUCCESS', [checkRun('build', 'COMPLETED', 'SUCCESS')])))).toMatchObject({
      outcome: 'passed',
      isRunning: false,
      workflow: '',
      at: AT('10:05:00'),
    })
  })

  test('is skipped when every check was skipped', () => {
    expect(
      branchCi(
        commit(
          rollup('SUCCESS', [checkRun('docs', 'COMPLETED', 'SKIPPED'), checkRun('notes', 'COMPLETED', 'NEUTRAL')]),
        ),
      ),
    ).toMatchObject({ outcome: 'skipped', isRunning: false })
  })

  test('is null when the commit has no checks, or the branch is not on the remote', () => {
    expect(branchCi(commit(null))).toBeNull()
    expect(dataOf(answer({ repository: { branch: null } })).ci).toBeNull()
    expect(dataOf(answer({ repository: { branch: undefined } })).ci).toBeNull()
    expect(dataOf(answer({ repository: { branch: { target: null } } })).ci).toBeNull()
  })

  test('is read for the default branch as for the branch, contexts and all', () => {
    expect(defaultCi(commit(rollup('FAILURE', [checkRun('build', 'COMPLETED', 'FAILURE')]), DEFAULT_SHA))).toEqual({
      workflow: 'build',
      outcome: 'failed',
      isRunning: false,
      at: AT('10:05:00'),
      url: 'https://github.com/acme/widgets/actions/runs/1/job/1',
      sha: 'a1b2c3d',
    })
    expect(defaultCi(commit(rollup('PENDING', [checkRun('build', 'QUEUED', null)]), DEFAULT_SHA))).toMatchObject({
      outcome: 'pending',
      isRunning: true,
    })
    expect(defaultCi(commit(null, DEFAULT_SHA))).toBeNull()
  })

  test('keeps the two apart', () => {
    const data = dataOf(answer())

    expect(data.ci?.outcome).toBe('failed')
    expect(data.defaultCi?.outcome).toBe('passed')
  })

  test("has neither branch pull request nor branch CI on the default branch, and still has the default branch's CI", () => {
    const onMain = answer({ repository: { branch: undefined, head: undefined } })
    const data = dataOf(onMain, { hasHead: false })

    expect(data.pr).toBeNull()
    expect(data.ci).toBeNull()
    expect(data.defaultCi).toMatchObject({ outcome: 'passed', sha: 'a1b2c3d' })
    expect(data.tickets.map(ticket => ticket.number)).toEqual([123, 45])
  })
})

/** What gh printed, and left on stderr, when a call went wrong: the shapes gh 2.97 gave (names made generic). */
const NOT_FOUND_REPOSITORY = json({
  data: {
    viewer: { login: 'octocat' },
    rateLimit: { cost: 1, remaining: 4989, resetAt: '2026-10-07T17:12:50Z' },
    repository: null,
  },
  errors: [
    {
      type: 'NOT_FOUND',
      path: ['repository'],
      locations: [{ line: 1, column: 86 }],
      message: "Could not resolve to a Repository with the name 'acme/widgets'.",
    },
  ],
})
const BAD_CREDENTIALS = json({
  message: 'Bad credentials',
  documentation_url: 'https://docs.github.com/rest',
  status: '401',
})
const NO_LOGIN =
  'To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.\n'
const RESET = Date.parse('2026-10-07T13:00:00Z')

function rateLimited(resetAt?: string): string {
  return json({
    errors: [
      { type: 'RATE_LIMITED', code: 'graphql_rate_limit', message: 'API rate limit already exceeded for user ID 1.' },
    ],
    data: resetAt === undefined ? null : { rateLimit: { cost: 1, remaining: 0, resetAt } },
  })
}

describe('parseAnswer: what went wrong', () => {
  const OFF = (reason: string): GithubAnswer => ({ kind: 'off', reason })
  const TROUBLE = (reason: string, retryAtMs: number | null = null): GithubAnswer => ({
    kind: 'trouble',
    reason,
    retryAtMs,
  })
  const LOGIN = 'gh is not logged in: run gh auth login'
  const REJECTED = 'gh credentials were rejected: run gh auth login'
  const NOT_SET_UP = 'gh is not set up here'
  const OFFLINE = 'GitHub is not reachable'
  const LIMIT = 'GitHub rate limit reached'
  const FAILED = 'GitHub answered with an error'

  // [name, stdout, exit code, stderr, answer]
  const CASES: [string, string, number, string, GithubAnswer][] = [
    // Only the person can fix it.
    ['exit 4: not logged in', '', 4, NO_LOGIN, OFF(LOGIN)],
    ['exit 4 by its code alone', '', 4, '', OFF(LOGIN)],
    ['not logged in by its text alone', '', 1, NO_LOGIN, OFF(LOGIN)],
    [
      'a token GitHub refuses, by its body and its text',
      BAD_CREDENTIALS,
      1,
      'gh: Bad credentials (HTTP 401)\n',
      OFF(REJECTED),
    ],
    ['a token GitHub refuses, by its body alone', BAD_CREDENTIALS, 1, '', OFF(REJECTED)],
    [
      'a token GitHub refuses, by its text alone (it also offers a login)',
      '',
      1,
      'HTTP 401: Bad credentials (https://api.github.com/graphql)\nTry authenticating with:  gh auth login -h github.com\n',
      OFF(REJECTED),
    ],
    [
      'a shim with no version set',
      '',
      126,
      'No version is set for command gh\nConsider adding one of the following versions in your config file at /work/.tool-versions\ngithub-cli 2.97.0\n',
      OFF(NOT_SET_UP),
    ],
    ['a command the wrapper could not find', '', 127, 'gh: command not found\n', OFF(NOT_SET_UP)],
    [
      'a repository that came back null',
      NOT_FOUND_REPOSITORY,
      1,
      "gh: Could not resolve to a Repository with the name 'acme/widgets'.\n",
      OFF('gh cannot see acme/widgets'),
    ],
    [
      'a repository that came back null, by its body alone',
      NOT_FOUND_REPOSITORY,
      0,
      '',
      OFF('gh cannot see acme/widgets'),
    ],
    // It may pass.
    [
      'a rate limit, with the time it resets',
      rateLimited('2026-10-07T13:00:00Z'),
      1,
      'gh: API rate limit already exceeded for user ID 1.\n',
      TROUBLE(LIMIT, RESET),
    ],
    ['a rate limit, with no time', rateLimited(), 1, '', TROUBLE(LIMIT)],
    ['a rate limit, with a time that is not one', rateLimited('later'), 1, '', TROUBLE(LIMIT)],
    ['a rate limit by its type alone', json({ errors: [{ type: 'RATE_LIMITED' }] }), 1, '', TROUBLE(LIMIT)],
    [
      'a secondary rate limit (a body that is not GraphQL)',
      json({
        message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.',
        documentation_url: 'https://docs.github.com/rest/overview/rate-limits-for-the-rest-api',
      }),
      1,
      'gh: You have exceeded a secondary rate limit. Please wait a few minutes before you try again. (HTTP 403)\n',
      TROUBLE(LIMIT),
    ],
    [
      'a primary rate limit on the REST side',
      '',
      1,
      'HTTP 403: API rate limit exceeded for user ID 1. If you reach out to GitHub Support for help, please include the request ID ABCD:1234. (https://api.github.com/graphql)\n',
      TROUBLE(LIMIT),
    ],
    [
      'the older abuse detection',
      '',
      1,
      'HTTP 403: You have triggered an abuse detection mechanism. Please wait a few minutes before you try again.\n',
      TROUBLE(LIMIT),
    ],
    ['too many requests', '', 1, 'HTTP 429: Too Many Requests (https://api.github.com/graphql)\n', TROUBLE(LIMIT)],
    [
      'a rate limit text that also offers a login',
      '',
      1,
      'HTTP 403: API rate limit exceeded. Try authenticating with:  gh auth login\n',
      TROUBLE(LIMIT),
    ],
    [
      'offline, through a dead proxy',
      '',
      1,
      'Post "https://api.github.com/graphql": proxyconnect tcp: dial tcp 127.0.0.1:1: i/o timeout\n',
      TROUBLE(OFFLINE),
    ],
    [
      'offline, as gh words it',
      '',
      1,
      'error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com\n',
      TROUBLE(OFFLINE),
    ],
    [
      'a host that does not resolve',
      '',
      1,
      'Post "https://api.github.com/graphql": dial tcp: lookup api.github.com: no such host\n',
      TROUBLE(OFFLINE),
    ],
    [
      'a handshake that timed out',
      '',
      1,
      'Post "https://api.github.com/graphql": net/http: TLS handshake timeout\n',
      TROUBLE(OFFLINE),
    ],
    [
      'a connection that was refused',
      '',
      1,
      'Post "https://api.github.com/graphql": dial tcp 140.82.112.5:443: connect: connection refused\n',
      TROUBLE(OFFLINE),
    ],
    [
      'a deadline that passed',
      '',
      1,
      'Post "https://api.github.com/graphql": context deadline exceeded\n',
      TROUBLE(OFFLINE),
    ],
    // GitHub answering is not GitHub being out of reach.
    [
      'a gateway timeout at GitHub',
      '',
      1,
      'HTTP 504: 504 Gateway Timeout (https://api.github.com/graphql)\n',
      TROUBLE(FAILED),
    ],
    [
      'a bad gateway',
      '<html><body>502 Bad Gateway</body></html>',
      1,
      'HTTP 502: Bad Gateway (https://api.github.com/graphql)\n',
      TROUBLE(FAILED),
    ],
    ['a failure that says nothing', '', 1, '', TROUBLE(FAILED)],
    ['a failure with an unknown text', '', 2, 'something else went wrong', TROUBLE(FAILED)],
    [
      'a token without a scope',
      '',
      1,
      'error: your authentication token is missing required scopes [read:org]\nTo request it, run:  gh auth refresh -s read:org\n',
      TROUBLE(FAILED),
    ],
    [
      'an error with no type and no data',
      json({ errors: [{ message: 'Something went wrong while executing your query.' }] }),
      1,
      '',
      TROUBLE(FAILED),
    ],
    [
      'an error of a type it does not know',
      json({ errors: [{ type: 'SOMETHING_NEW', message: 'Hm.' }] }),
      1,
      '',
      TROUBLE(FAILED),
    ],
  ]

  for (const [name, stdout, exitCode, stderr, expected] of CASES) {
    test(`${name} is ${expected.kind}${expected.kind === 'ok' ? '' : `: ${expected.reason}`}`, () => {
      expect(parseAnswer(stdout, exitCode, stderr, ask({ refs: REFS }))).toEqual(expected)
    })
  }

  test('names the repository it was asked about, cleaned', () => {
    const asked = ask({ remote: { host: 'github.com', owner: 'octo-org', name: 'a.b_c' } })

    expect(parseAnswer(NOT_FOUND_REPOSITORY, 1, '', asked)).toEqual(OFF('gh cannot see octo-org/a.b_c'))
  })

  test('puts a rate limit before the logins, which it can also offer, and a refused token before a missing login', () => {
    const both = 'HTTP 401: Bad credentials\nTo get started with GitHub CLI, please run:  gh auth login\n'

    expect(parseAnswer('', 1, both, ask())).toEqual(OFF(REJECTED))
    expect(parseAnswer('', 1, `${both}API rate limit exceeded`, ask())).toEqual(TROUBLE(LIMIT))
  })

  test('puts a missing gh before everything else it can say', () => {
    expect(parseAnswer('', 127, 'rate limit gh auth login Bad credentials', ask())).toEqual(OFF(NOT_SET_UP))
    expect(parseAnswer(rateLimited('2026-10-07T13:00:00Z'), 126, '', ask())).toEqual(OFF(NOT_SET_UP))
  })

  test('does not read a repository name as a rate limit', () => {
    const named = json({
      data: { repository: null },
      errors: [
        {
          type: 'NOT_FOUND',
          path: ['repository'],
          message: "Could not resolve to a Repository with the name 'acme/rate-limit-docs'.",
        },
      ],
    })

    expect(parseAnswer(named, 1, '', ask())).toEqual(OFF('gh cannot see acme/widgets'))
  })

  test('reads only the head of a long stderr', () => {
    expect(parseAnswer('', 1, `${'x'.repeat(10_000)} rate limit`, ask())).toEqual(TROUBLE(FAILED))
    expect(parseAnswer('', 1, `rate limit ${'x'.repeat(10_000)}`, ask())).toEqual(TROUBLE(LIMIT))
  })

  test('does not read the data it returns as an answer when the answer is partly wrong: any error but a missing ticket fails the whole', () => {
    const wrong = (errors: unknown[], change: { data?: Obj; repository?: Obj } = {}): GithubAnswer =>
      parseAnswer(json({ ...answer(change), errors }), 1, '', ask({ refs: REFS }))

    expect(
      wrong(
        [{ type: 'FORBIDDEN', path: ['review'], message: 'Resource protected by organization SAML enforcement.' }],
        { data: { review: null } },
      ),
    ).toEqual(TROUBLE(FAILED))
    expect(wrong([{ type: 'NOT_FOUND', path: ['repository', 'r999'], message: 'Could not resolve 999.' }])).toEqual(
      TROUBLE(FAILED),
    )
    expect(wrong([{ type: 'NOT_FOUND', path: ['repository'], message: 'Could not resolve.' }])).toEqual(TROUBLE(FAILED))
    expect(wrong([{ type: 'NOT_FOUND', path: ['repository', 'r45', 'title'], message: 'x' }])).toEqual(TROUBLE(FAILED))
    expect(wrong([{ type: 'NOT_FOUND', path: ['repository', 'team'], message: 'x' }])).toEqual(TROUBLE(FAILED))
    expect(wrong([{ type: 'INSUFFICIENT_SCOPES', message: 'x' }])).toEqual(TROUBLE(FAILED))
    expect(wrong([{ message: 'no type' }])).toEqual(TROUBLE(FAILED))
    expect(wrong([null])).toEqual(TROUBLE(FAILED))
    // A ticket that names nothing beside one that is worse is still a failure.
    expect(
      wrong([
        { type: 'NOT_FOUND', path: ['repository', 'r45'], message: 'x' },
        { type: 'FORBIDDEN', path: ['assigned'], message: 'x' },
      ]),
    ).toEqual(TROUBLE(FAILED))
    // A rate limit beside data is a rate limit.
    expect(wrong([{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }])).toEqual(TROUBLE(LIMIT, RESET))
  })

  test('does not take errors it cannot read for none: they fail the answer, unless there are none', () => {
    const withErrors = (errors: unknown): GithubAnswer =>
      parseAnswer(json({ ...answer(), errors }), 1, '', ask({ refs: REFS }))

    for (const errors of ['boom', 7, true, {}, { message: 'x' }]) {
      expect(withErrors(errors)).toEqual(TROUBLE(FAILED))
    }
    for (const errors of [undefined, null, []]) {
      expect(withErrors(errors).kind).toBe('ok')
    }
  })

  test('only a ticket that was asked for is one that may name nothing', () => {
    const missing = json({
      ...answer({ repository: { r45: null } }),
      errors: [{ type: 'NOT_FOUND', path: ['repository', 'r45'], message: 'x' }],
    })

    expect(parseAnswer(missing, 1, '', ask({ refs: REFS })).kind).toBe('ok')
    expect(parseAnswer(missing, 1, '', ask({ refs: [{ number: 123, source: 'branch' }] }))).toEqual(TROUBLE(FAILED))
    expect(parseAnswer(missing, 1, '', ask({ refs: [] }))).toEqual(TROUBLE(FAILED))
  })

  test('fails when the repository is not in the answer at all, which is not "cannot see it"', () => {
    expect(parseAnswer(json({ data: { viewer: { login: 'octocat' } } }), 0, '', ask())).toEqual(TROUBLE(FAILED))
    expect(parseAnswer(json({ data: { repository: 'acme/widgets' } }), 0, '', ask())).toEqual(TROUBLE(FAILED))
    expect(parseAnswer(json({ data: { repository: [] } }), 0, '', ask())).toEqual(TROUBLE(FAILED))
    expect(parseAnswer(json({ data: {} }), 0, '', ask())).toEqual(TROUBLE(FAILED))
    expect(parseAnswer(json({ data: null }), 0, '', ask())).toEqual(TROUBLE(FAILED))
  })

  const GARBAGE = [
    '',
    ' ',
    'not json',
    '[]',
    'null',
    '42',
    '"x"',
    'true',
    '{',
    '{"data":',
    '<html>502</html>',
    `${json(answer())}x`,
    json(answer()).slice(0, 200),
  ]

  for (const stdout of GARBAGE) {
    test(`takes ${JSON.stringify(stdout.slice(0, 24))} on a success exit as an error, not as nothing found`, () => {
      expect(parseAnswer(stdout, 0, '', ask())).toEqual(TROUBLE(FAILED))
    })
  }

  test('tells garbage on a failing exit by the exit code and the text', () => {
    expect(parseAnswer('not json', 4, '', ask())).toEqual(OFF(LOGIN))
    expect(parseAnswer('<html>', 127, '', ask())).toEqual(OFF(NOT_SET_UP))
    expect(parseAnswer('not json', 1, 'error connecting to api.github.com', ask())).toEqual(TROUBLE(OFFLINE))
    expect(parseAnswer('[', 1, 'HTTP 429', ask())).toEqual(TROUBLE(LIMIT))
  })

  test('never throws, and always answers one of the three', () => {
    const stdouts: unknown[] = [
      undefined,
      null,
      5,
      {},
      [],
      '',
      'x',
      json(answer()),
      json({ data: { repository: {} } }),
      json({ data: { repository: { head: 7, team: 'x', branch: [] } }, errors: 'x' }),
      json({ errors: [null, 5, 'x', [], {}] }),
    ]
    const stderrs: unknown[] = [undefined, null, 5, {}, '', 'rate limit']
    const codes: unknown[] = [0, 1, 4, 126, 127, Number.NaN, undefined, null, '4', -1]
    const asks = [
      ask(),
      ask({ refs: [] }),
      ask({ lists: false }),
      ask({
        refs: [
          { number: 0, source: 'branch' },
          { number: Number.NaN, source: 'pr' },
        ],
      }),
    ]

    for (const stdout of stdouts) {
      for (const stderr of stderrs) {
        for (const code of codes) {
          for (const input of asks) {
            const result = parseAnswer(stdout as never, code as never, stderr as never, input)

            expect(['ok', 'off', 'trouble']).toContain(result.kind)
            if (result.kind !== 'ok') {
              expect(typeof result.reason).toBe('string')
              expect(result.reason).not.toBe('')
            }
          }
        }
      }
    }
  })

  test('does not change the input it was given', () => {
    const input = ask({ refs: REFS })
    const before = json(input)

    parseAnswer(json(answer()), 0, '', input)
    parseAnswer('x', 1, 'y', input)
    expect(json(input)).toBe(before)
  })
})

// ---------------------------------------------------------------- text from outside

/** A colour escape, a bidi override, a zero-width space, a bell and a lone surrogate go; a NEL is a line break, so a space. */
const FOUL = '\u001b[31m\u202e\u200bX\u0007\ud800Y\u0085'

/** Every string in a value, however deep. */
function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value]
  }
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).flatMap(stringsIn)
  }

  return []
}

/** Every value under a key of that name, however deep. */
function valuesOf(value: unknown, key: string): unknown[] {
  if (Array.isArray(value)) {
    return value.flatMap(one => valuesOf(one, key))
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([name, one]) => (name === key ? [one] : valuesOf(one, key)))
  }

  return []
}

describe('parseAnswer: text from outside', () => {
  const foul = (): GithubData => {
    const node = {
      ...HEAD_PR,
      title: FOUL,
      author: { login: FOUL },
      headRefName: FOUL,
      url: `https://example.com/${FOUL}`,
      updatedAt: FOUL,
      reviewRequests: {
        nodes: [
          { requestedReviewer: { __typename: 'User', login: FOUL } },
          { requestedReviewer: { __typename: 'Team', slug: `${FOUL}2` } },
        ],
      },
      latestReviews: { nodes: [{ state: 'APPROVED', author: { login: FOUL } }] },
      closingIssuesReferences: { nodes: [{ ...CLOSING_123, title: FOUL, url: FOUL }] },
      statusCheckRollup: rollup('FAILURE', [
        checkRun(FOUL, 'COMPLETED', 'FAILURE', { detailsUrl: FOUL }),
        statusContext(`${FOUL}2`, 'SUCCESS', { targetUrl: FOUL }),
      ]),
    }
    const body = answer({
      data: {
        viewer: { login: FOUL },
        review: {
          issueCount: 1,
          nodes: [row(88, { title: FOUL, author: { login: FOUL }, headRefName: FOUL, url: FOUL, updatedAt: FOUL })],
        },
        assigned: {
          issueCount: 1,
          nodes: [
            { number: 5, title: FOUL, url: FOUL, updatedAt: FOUL, closedByPullRequestsReferences: { nodes: [] } },
          ],
        },
      },
      repository: {
        head: { nodes: [node] },
        defaultBranchRef: {
          name: FOUL,
          target: commit(rollup('FAILURE', [checkRun(FOUL, 'COMPLETED', 'FAILURE', { detailsUrl: FOUL })])),
        },
        branch: { target: commit(rollup('FAILURE', [checkRun(FOUL, 'COMPLETED', 'FAILURE', { detailsUrl: FOUL })])) },
        team: {
          totalCount: 1,
          nodes: [
            {
              ...row(70, { title: FOUL, author: { login: FOUL }, headRefName: FOUL, url: FOUL, updatedAt: FOUL }),
              closingIssuesReferences: { nodes: [] },
            },
          ],
        },
        r45: { __typename: 'Issue', number: 45, title: FOUL, state: FOUL, url: FOUL },
      },
    })

    return dataOf(body)
  }

  test('is clean in everything the answer hands on', () => {
    const data = foul()

    expect(data.viewer).toBe('XY')
    expect(data.defaultBranch).toBe('XY')
    expect(data.pr).toMatchObject({
      title: 'XY',
      author: 'XY',
      branch: 'XY',
      url: '',
      updatedAt: '',
      reviewers: ['XY', '@XY 2'],
      reviews: [{ author: 'XY', state: 'approved' }],
      checks: [
        { name: 'XY', outcome: 'failed' },
        { name: 'XY 2', outcome: 'passed' },
      ],
    })
    expect(data.ci).toMatchObject({ workflow: 'XY', url: '' })
    expect(data.defaultCi).toMatchObject({ workflow: 'XY', url: '' })
    expect(data.tickets[0]).toMatchObject({ title: 'XY', url: '', state: 'open' })
    expect(data.tickets[1]).toMatchObject({ title: 'XY', url: '', state: '' })
    expect(data.board?.[0]).toMatchObject({ title: 'XY', author: 'XY', branch: 'XY', url: '', updatedAt: '' })
    expect(data.reviewQueue?.[0]).toMatchObject({ title: 'XY', author: 'XY', branch: 'XY', url: '', updatedAt: '' })
    expect(data.assigned?.[0]).toMatchObject({ title: 'XY', url: '', updatedAt: '' })
    for (const text of stringsIn(data)) {
      expect(UNFIT.test(text)).toBe(false)
    }
  })

  test('is cut to the length it is kept at', () => {
    const long = 'w'.repeat(1000)
    const node = { ...HEAD_PR, title: long, headRefName: long, author: { login: long } }
    const pr = dataOf(answer({ repository: { head: { nodes: [node] } } })).pr

    expect(Array.from(pr?.title ?? '')).toHaveLength(256)
    expect(pr?.title.endsWith('…')).toBe(true)
    expect(Array.from(pr?.branch ?? '')).toHaveLength(255)
    expect(Array.from(pr?.author ?? '')).toHaveLength(160)
  })

  test('keeps a link only when it is a plain http(s) address of up to 2048 characters', () => {
    const linked = (url: unknown): string | undefined =>
      dataOf(answer({ repository: { head: { nodes: [{ ...HEAD_PR, url }] } } })).pr?.url

    expect(linked('https://github.com/acme/widgets/pull/42')).toBe('https://github.com/acme/widgets/pull/42')
    expect(linked('http://ghe.example.com/acme/widgets/pull/42')).toBe('http://ghe.example.com/acme/widgets/pull/42')

    const longest = `https://example.com/${'a'.repeat(2048 - 'https://example.com/'.length)}`

    expect(linked(longest)).toBe(longest)
    expect(linked(`${longest}a`)).toBe('')
    for (const url of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'https://example.com/a b',
      'https://example.com/\u001b[31m',
      'https://example.com/\u202e',
      '',
      42,
      null,
    ]) {
      expect(linked(url)).toBe('')
    }
  })

  test('keeps a timestamp only in the form GitHub writes', () => {
    const stamped = (updatedAt: unknown): string | undefined =>
      dataOf(answer({ repository: { head: { nodes: [{ ...HEAD_PR, updatedAt }] } } })).pr?.updatedAt

    expect(stamped('2026-10-07T10:06:00Z')).toBe('2026-10-07T10:06:00Z')
    expect(stamped('2026-10-07T10:06:00.123+02:00')).toBe('2026-10-07T10:06:00.123+02:00')
    for (const value of [
      'yesterday-ish',
      'Oct\u00077 2026',
      '7 Oct 2026\n',
      '2026-10-07 \u0000',
      'Oct 7 2026 (‮)',
      '2026-10-07',
      5,
      null,
    ]) {
      expect(stamped(value)).toBe('')
    }
  })

  test('names a bot by its login and a deleted author as GitHub does', () => {
    const authored = (author: unknown): string | undefined =>
      dataOf(answer({ repository: { head: { nodes: [{ ...HEAD_PR, author }] } } })).pr?.author

    expect(authored({ login: 'dependabot' })).toBe('dependabot')
    expect(authored(null)).toBe('ghost')
    expect(authored('alice')).toBe('ghost')
    expect(authored({ login: '' })).toBe('ghost')
  })

  test('survives odd fields: a pull request is still a pull request', () => {
    const odd = {
      ...HEAD_PR,
      reviewRequests: 'bob',
      latestReviews: { nodes: 'x' },
      statusCheckRollup: null,
      closingIssuesReferences: 7,
      title: 12,
      headRefName: null,
      mergeStateStatus: {},
      isDraft: 'yes',
    }

    expect(dataOf(answer({ repository: { head: { nodes: [odd] } } })).pr).toEqual({
      number: 42,
      title: '',
      url: 'https://github.com/acme/widgets/pull/42',
      author: 'alice',
      branch: '',
      isDraft: false,
      review: 'changes_requested',
      reviewers: [],
      reviews: [],
      checks: [],
      merge: 'unknown',
      isAutoMerge: true,
      closes: [],
      updatedAt: '2026-10-07T10:06:00Z',
    })
  })

  test('holds for the answer put through random damage: no throw, a shape that is whole, text that is clean', () => {
    const JUNK: unknown[] = [
      null,
      0,
      -1,
      1.5,
      2 ** 40,
      'x',
      '',
      FOUL,
      '\u202e',
      'https://example.com/a b',
      'OPEN',
      'COMPLETED',
      [],
      {},
      [null],
      { nodes: 'x' },
      { nodes: [null, 5] },
      true,
      false,
      '2026-10-07T10:06:00Z',
    ]
    const paths = (value: unknown, prefix: (string | number)[] = []): (string | number)[][] => {
      if (Array.isArray(value)) {
        return value.flatMap((one, at) => [[...prefix, at], ...paths(one, [...prefix, at])])
      }
      if (typeof value === 'object' && value !== null) {
        return Object.entries(value).flatMap(([key, one]) => [[...prefix, key], ...paths(one, [...prefix, key])])
      }

      return []
    }
    const random = seeded(20261008)
    const kinds = new Set<string>()
    let reads = 0

    for (let run = 0; run < 600; run += 1) {
      const doc = JSON.parse(json(answer())) as Obj

      for (let hits = 1 + Math.floor(random() * 6); hits > 0; hits -= 1) {
        // The paths are taken again after each hit: the one before may have cut a branch off.
        const spots = paths(doc)
        const path = spots[Math.floor(random() * spots.length)] ?? []
        const last = path[path.length - 1]
        const parent = path.slice(0, -1).reduce<unknown>((into, key) => (into as Obj)[key as string], doc) as Obj

        if (last !== undefined) {
          // A copy each time: a later hit may reach into what this one put there.
          parent[last] = JSON.parse(json(JUNK[Math.floor(random() * JUNK.length)])) as unknown
        }
      }

      const result = parseAnswer(json(doc), 0, '', ask({ refs: REFS }))

      kinds.add(result.kind)
      if (result.kind === 'ok') {
        reads += 1
        for (const text of stringsIn(result.data)) {
          expect(UNFIT.test(text)).toBe(false)
        }
        for (const url of valuesOf(result.data, 'url')) {
          expect(url === '' || /^https?:\/\/\S+$/.test(String(url))).toBe(true)
        }
        for (const number of valuesOf(result.data, 'number')) {
          expect(Number.isSafeInteger(number) && (number as number) > 0).toBe(true)
        }
        expect(result.data.tickets.length).toBeLessThanOrEqual(5)
        expect(new Set(result.data.tickets.map(ticket => ticket.number)).size).toBe(result.data.tickets.length)
        expect(Array.isArray(result.data.board) || result.data.board === null).toBe(true)
        expect(result.data.board?.some(one => one.number === result.data.pr?.number)).not.toBe(true)
        expect(Number.isFinite(result.data.defaultCi?.at ?? 0)).toBe(true)
        expect(Number.isFinite(result.data.ci?.at ?? 0)).toBe(true)
      }
    }
    // The damage really did reach both: answers that were read, and answers that were refused.
    expect(reads).toBeGreaterThan(100)
    expect(kinds.size).toBeGreaterThan(1)
  })
})
