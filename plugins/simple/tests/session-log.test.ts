import { describe, expect, test } from 'claude-code/testing'

import { createSessionLog, describeInput, mask } from '../hooks/session-log'
import type { SessionLog } from '../hooks/session-log'

// The session tracker takes plain data and a clock reading, never `$`, so
// every test here replays a session by calling it directly.

const T0 = Date.parse('2026-10-07T12:00:00Z')
const MCP = 'mcp__docs__search'

/** A fake credential: a known prefix and filler, so nothing in the source is a real token. */
const fake = (prefix: string, length: number) => `${prefix}${'x'.repeat(length)}`

type Call = {
  id: string
  tool: string
  agentId?: string
  input?: unknown
  isError?: boolean
  isDenied?: boolean
  result?: unknown
}

/** One call from its start to its end, `ms` apart. */
function run(log: SessionLog, call: Call, at: number, ms = 10): void {
  log.toolStarted({ id: call.id, tool: call.tool, agentId: call.agentId, input: call.input, nowMs: at })
  log.toolFinished({ ...call, nowMs: at + ms })
}

function spawn(log: SessionLog, id: string, at: number, over: { type?: string; description?: string; model?: string } = {}): void {
  log.agentSpawned({ id, type: 'Explore', description: 'Find the auth code', model: 'claude-sonnet-5-5', nowMs: at, ...over })
}

function finishAgent(log: SessionLog, id: string, at: number, reason = 'answer', answer = 'Done.'): void {
  log.turnCompleted({ agentId: id, reason, answer, durationMs: 1000, nowMs: at })
}

/** A Bash result that carries a structured git operation. */
const git = (operation: object) => ({ stdout: '', stderr: '', interrupted: false, gitOperation: operation })

describe('describeInput', () => {
  test('says what a shell call runs', () => {
    expect(describeInput('Bash', { command: 'git status --short' })).toBe('git status --short')
    expect(describeInput('PowerShell', { command: 'Get-ChildItem -Recurse' })).toBe('Get-ChildItem -Recurse')
    expect(describeInput('Monitor', { command: 'tail -f app.log', description: 'watch the log' })).toBe('tail -f app.log')
    expect(describeInput('Monitor', { ws: { url: 'wss://events.example.com/feed' }, description: 'watch' })).toBe(
      'wss://events.example.com/feed',
    )
    expect(describeInput('Monitor', { description: 'watch the feed' })).toBe('watch the feed')
  })

  test('keeps a command on one line', () => {
    expect(describeInput('Bash', { command: 'echo one\n\n  echo   two\t' })).toBe('echo one echo two')
  })

  test('names the file of a file tool', () => {
    expect(describeInput('Read', { file_path: '/repo/src/index.ts', offset: 10 })).toBe('/repo/src/index.ts')
    expect(describeInput('Edit', { file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' })).toBe('/repo/src/a.ts')
    expect(describeInput('Write', { file_path: '/repo/notes.md', content: 'hello' })).toBe('/repo/notes.md')
    expect(describeInput('NotebookEdit', { notebook_path: '/repo/lab.ipynb', new_source: 'x' })).toBe('/repo/lab.ipynb')
  })

  test('names the pattern and the place of a search', () => {
    expect(describeInput('Glob', { pattern: '**/*.ts', path: '/repo/src' })).toBe('**/*.ts in /repo/src')
    expect(describeInput('Grep', { pattern: 'retry' })).toBe('retry')
    expect(describeInput('Grep', { path: '/repo' })).toBe('/repo')
  })

  test('names the URL or the query of a web tool', () => {
    expect(describeInput('WebFetch', { url: 'https://docs.example.com/guide', prompt: 'summarize it' })).toBe(
      'https://docs.example.com/guide',
    )
    expect(describeInput('WebSearch', { query: 'mount a pane', mode: 'standard' })).toBe('mount a pane')
  })

  test('takes the first short string argument of an MCP tool', () => {
    expect(describeInput(MCP, { limit: 5, filters: { a: 1 }, query: 'how to mount a pane', other: 'x' })).toBe('how to mount a pane')
    // a long string gives way to a short one after it
    expect(describeInput(MCP, { body: 'z'.repeat(200), id: 'DOC-7' })).toBe('DOC-7')
    expect(describeInput(MCP, { limit: 5 })).toBe('')

    // only long strings: the first one, cut
    const long = describeInput(MCP, { body: 'z'.repeat(300) })

    expect(long.length).toBe(120)
    expect(long.endsWith('…')).toBe(true)
  })

  test('falls back to the description, or the first short string, of any other tool', () => {
    expect(describeInput('Agent', { prompt: 'Look in src', subagent_type: 'Explore', description: 'Find the auth code' })).toBe(
      'Find the auth code',
    )
    expect(describeInput('TaskCreate', { subject: 'Write the pane' })).toBe('Write the pane')
    expect(describeInput('Skill', { skill: 'review', args: 5 })).toBe('review')
  })

  test('never shows an argument kept under a secret name, whose value alone no rule would catch', () => {
    expect(describeInput(MCP, { password: 'hunter2', host: 'db.example.com' })).toBe('db.example.com')
    expect(describeInput(MCP, { api_key: 'abc123', authToken: 'xyz789', query: 'mods' })).toBe('mods')
    expect(describeInput(MCP, { Authorization: 'Basic abc', credentials: 'abc', Cookie: 'sid=abc' })).toBe('')
    expect(describeInput('TaskCreate', { client_secret: 'abc123' })).toBe('')
  })

  test('is empty when the input says nothing', () => {
    expect(describeInput('Bash', undefined)).toBe('')
    expect(describeInput('Bash', null)).toBe('')
    expect(describeInput('Bash', 'ls')).toBe('')
    expect(describeInput('Bash', ['ls'])).toBe('')
    expect(describeInput(MCP, ['query text'])).toBe('')
    expect(describeInput('Read', {})).toBe('')
    expect(describeInput(MCP, {})).toBe('')
  })

  test('masks secrets', () => {
    expect(describeInput('Bash', { command: `curl -H "Authorization: Bearer ${'t'.repeat(20)}" https://api.example.com` })).toBe(
      'curl -H "Authorization: •••" https://api.example.com',
    )
    expect(describeInput('WebFetch', { url: 'https://octocat:hunter2@example.com/feed?token=abc123' })).toBe(
      'https://octocat:•••@example.com/feed?token=•••',
    )
  })

  test('masks before it cuts, so a secret on the edge leaves no stub', () => {
    const command = `${'x'.repeat(110)} ${fake('ghp_', 36)}`

    expect(describeInput('Bash', { command })).toBe(`${'x'.repeat(110)} •••`)
  })

  test('cuts long text to 120 characters, ending in an ellipsis', () => {
    const out = describeInput('Bash', { command: `echo ${'z'.repeat(500)}` })

    expect(out.length).toBe(120)
    expect(out.startsWith('echo zzz')).toBe(true)
    expect(out.endsWith('…')).toBe(true)
  })
})

describe('mask', () => {
  test('hides GitHub tokens', () => {
    expect(mask(`gh auth login --with-token ${fake('ghp_', 36)}`)).toBe('gh auth login --with-token •••')
    expect(mask(`${fake('gho_', 36)} and ${fake('github_pat_', 40)}`)).toBe('••• and •••')
  })

  test('hides sk- keys', () => {
    expect(mask(`the key is ${fake('sk-proj-', 24)}`)).toBe('the key is •••')
    expect(mask(fake('sk-ant-api03-', 30))).toBe('•••')
  })

  test('hides AWS access key ids', () => {
    expect(mask(`id ${'AKIA'}${'IOSFODNN7EXAMPLE'} ok`)).toBe('id ••• ok')
  })

  test('hides Slack, npm and Google tokens', () => {
    expect(mask(`${'xoxb'}-123456789012-abcdefghijkl`)).toBe('•••')
    expect(mask(fake('npm_', 36))).toBe('•••')
    expect(mask(fake('AIza', 35))).toBe('•••')
  })

  test('hides bearer tokens and authorization headers', () => {
    expect(mask('Bearer x')).toBe('Bearer •••')
    expect(mask('curl -H "Authorization: Bearer abc.def.ghi123" https://api.example.com')).toBe(
      'curl -H "Authorization: •••" https://api.example.com',
    )
    expect(mask('Authorization: Basic dXNlcjpwYXNz')).toBe('Authorization: •••')
    expect(mask('{"Authorization": "Bearer abc"}')).toBe('{"Authorization": "•••"}')
  })

  test('hides the value after password=, token=, secret= and api_key=', () => {
    expect(mask('password=hunter2 ls')).toBe('password=••• ls')
    expect(mask('curl "https://host/path?token=abc&page=2"')).toBe('curl "https://host/path?token=•••&page=2"')
    expect(mask("secret='my secret' next")).toBe('secret=••• next')
    expect(mask('api_key=abc123 run')).toBe('api_key=••• run')
    expect(mask('{"password": "hunter2", "user": "alice"}')).toBe('{"password": •••, "user": "alice"}')
    expect(mask('GITHUB_TOKEN=abc123 npm publish')).toBe('GITHUB_TOKEN=••• npm publish')
    expect(mask('x-api-key: abc123')).toBe('x-api-key: •••')
    expect(mask('mysql --password hunter2 -h db')).toBe('mysql --password ••• -h db')
    expect(mask('mysql --password=hunter2 -h db')).toBe('mysql --password=••• -h db')
    // a flag after the name is no value
    expect(mask('deploy --token --dry-run')).toBe('deploy --token --dry-run')
  })

  test('hides the value under the other names a secret is kept under', () => {
    for (const name of [
      'passwd',
      'passphrase',
      'pwd',
      'secret_key',
      'secret-key',
      'client_secret',
      'access_key',
      'AWS_SECRET_ACCESS_KEY',
      'private_key',
      'api-key',
      'apikey',
    ]) {
      expect(mask(`${name}=abc123 run`)).toBe(`${name}=••• run`)
    }
  })

  test('hides credentials in a URL', () => {
    expect(mask('psql postgres://bob:hunter2@db.example.com/app')).toBe('psql postgres://bob:•••@db.example.com/app')
  })

  test('hides hex and base64 runs over 32 characters, and only those', () => {
    const hex = '0123456789abcdef0123456789abcdef'
    const base64 = 'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF'

    expect(hex.length).toBe(32)
    expect(base64.length).toBe(32)
    expect(mask(hex)).toBe(hex)
    expect(mask(`${hex}0`)).toBe('•••')
    expect(mask('git show 0123456789abcdef0123456789abcdef01234567')).toBe('git show •••')
    expect(mask(hex.toUpperCase())).toBe(hex.toUpperCase())
    expect(mask(`${hex.toUpperCase()}0`)).toBe('•••')
    expect(mask(base64)).toBe(base64)
    expect(mask(`${base64}3`)).toBe('•••')
    expect(mask('secret text wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY here')).toBe('secret text ••• here')
  })

  test('hides private key blocks and JWTs', () => {
    expect(mask('-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY----- after')).toBe('••• after')
    expect(mask(`eyJ${'a'.repeat(10)}.${'b'.repeat(10)}.${'c'.repeat(10)}`)).toBe('•••')
  })

  test('keeps what is not secret', () => {
    for (const plain of [
      'git status --short',
      '/home/alice/workspace/widgets/plugins/simple/hooks/session-log.ts',
      '/home/alice/Projects/app2/src/components/Button/index.tsx',
      'git push origin feature/ABC-123-add-new-Widget-parser',
      'git show abc1234',
      '123e4567-e89b-12d3-a456-426614174000',
      'max_tokens=4096',
      'PASSWORD_FILE=/run/secrets/db',
      'npm run test -- --grep "token budget"',
    ]) {
      expect(mask(plain)).toBe(plain)
    }
  })

  test('keeps long runs that do not look random: no digit, one case only, or many separators', () => {
    for (const plain of [
      'WidgetFactoryAbstractSingletonProxyBeanImpl',
      'abcdefghijklmnopqrstuvwxyz0123456789abc',
      'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABC',
      'feature/ABC-123-add-new-Widget-parser-v2',
    ]) {
      expect(plain.length).toBeGreaterThan(32)
      expect(mask(plain)).toBe(plain)
    }
  })

  test('keeps paths and branch names in camelCase with a digit, and still hides random keys', () => {
    for (const plain of [
      'src/components/DashboardWidgetContainer2.tsx',
      '/Users/alice/Library/CloudStorage/GoogleDrive2/x',
      'git checkout feature/ABC1234AddWidgetParserV2',
    ]) {
      expect(mask(plain)).toBe(plain)
    }
    for (const key of ['kSiN3g6v0V9qLJHn7hT0D2t8xZp5Wq1yR4mUeBcF', 'dGhpcyBpcyBhIHNlY3JldCB0b2tlbiB2YWx1ZQ7xQ==']) {
      expect(mask(`key ${key}`)).toBe('key •••')
    }
  })

  test('hides GitLab tokens, curl and mysql passwords', () => {
    expect(mask('token glpat-abcdefghijklmnopqrst here')).toBe('token ••• here')
    expect(mask('curl -u alice:s3cr3t https://api.example.com')).toBe('curl -u alice:••• https://api.example.com')
    expect(mask('curl --user=alice:s3cr3t https://api.example.com')).toBe('curl --user=alice:••• https://api.example.com')
    expect(mask('mysql -u root -phunter2 widgets')).toBe('mysql -u root -p••• widgets')
    expect(mask('mysql -u root -p widgets')).toBe('mysql -u root -p widgets')
  })

  test('cuts to the limit, 200 characters by default, ending in an ellipsis', () => {
    expect(mask('abcdef', 4)).toBe('abc…')
    expect(mask('abc def', 5)).toBe('abc…')
    expect(mask('abc', 4)).toBe('abc')
    expect(mask('abc', 0)).toBe('')
    expect(mask('z'.repeat(300)).length).toBe(200)
  })

  test('masks before it cuts', () => {
    expect(mask(`zzzzz ${fake('ghp_', 36)}`, 14)).toBe('zzzzz •••')
  })

  test('drops escape sequences, control characters and invisible marks before it masks', () => {
    expect(mask('echo \u001b[31mred\u001b[0m \u0007done\u200b \u009b1mbold \u001b]0;title\u0007end')).toBe('echo red done bold end')
    expect(mask('ls \u202egnp.exe')).toBe('ls gnp.exe')
    // a mark nobody sees inside a token does not hide it from the rules
    expect(mask(`${fake('ghp_', 4)}\u200b${'x'.repeat(32)}`)).toBe('•••')
    // tabs and line breaks stay for the caller
    expect(mask('one\ttwo\nthree')).toBe('one\ttwo\nthree')
    expect(describeInput('Bash', { command: 'printf "\u001b[1mbold\u001b[0m"\u0000' })).toBe('printf "bold"')
  })

  test('does not split a surrogate pair when it cuts', () => {
    expect(mask(`${'z'.repeat(118)}😀tail`, 120)).toBe(`${'z'.repeat(118)}…`)
    expect(mask(`${'z'.repeat(117)}😀tail`, 120)).toBe(`${'z'.repeat(117)}😀…`)
  })

  test('stays fast on a huge input', () => {
    const started = Date.now()

    mask(`${'password='.repeat(500_000)}`)
    mask('-'.repeat(5_000_000))
    mask(`token ${'a-'.repeat(2_500_000)}`)
    expect(Date.now() - started).toBeLessThan(2000)
  })
})

describe('permission gate', () => {
  test('files each tool under its family', () => {
    const log = createSessionLog()
    const tools = [
      ['Read', 'file'],
      ['Edit', 'file'],
      ['Write', 'file'],
      ['NotebookEdit', 'file'],
      ['Glob', 'file'],
      ['Grep', 'file'],
      ['Bash', 'shell'],
      ['PowerShell', 'shell'],
      ['Monitor', 'shell'],
      ['WebFetch', 'web'],
      ['WebSearch', 'web'],
      [MCP, 'mcp'],
      ['Agent', 'other'],
      ['TaskCreate', 'other'],
    ] as const

    tools.forEach(([tool], index) => log.toolChecked({ id: `c${index}`, tool, decision: 'allow', nowMs: T0 }))
    expect(log.view(T0).gate.map(check => [check.tool, check.family])).toEqual(tools)
  })

  test('an allowed call is a rule verdict that says what it was about', () => {
    const log = createSessionLog()

    log.toolChecked({ id: 'a', tool: 'Bash', input: { command: 'git status' }, decision: 'allow', nowMs: T0 })
    expect(log.view(T0).gate).toEqual([
      { id: 'a', tool: 'Bash', family: 'shell', verdict: 'rule', inSubagent: false, detail: 'git status', at: T0 },
    ])
    expect(log.view(T0).log).toEqual([])
  })

  test('an ask stays pending until the call settles, then reads asked', () => {
    const log = createSessionLog()
    const input = { command: 'npm publish' }

    log.toolStarted({ id: 'a', tool: 'Bash', input, nowMs: T0 })
    log.toolChecked({ id: 'a', tool: 'Bash', input, decision: 'ask', nowMs: T0 + 10 })
    expect(log.view(T0 + 20).gate.map(check => check.verdict)).toEqual(['pending'])
    log.toolFinished({ id: 'a', tool: 'Bash', input, nowMs: T0 + 5000 })
    expect(log.view(T0 + 6000).gate.map(check => check.verdict)).toEqual(['asked'])
    expect(log.view(T0 + 6000).log).toEqual([])
  })

  test('an ask whose call then failed still ran: asked', () => {
    const log = createSessionLog()

    log.toolChecked({ id: 'a', tool: 'Bash', input: { command: 'make' }, decision: 'ask', nowMs: T0 })
    log.toolFinished({ id: 'a', tool: 'Bash', input: { command: 'make' }, isError: true, nowMs: T0 + 100 })
    expect(log.view(T0 + 100).gate.map(check => check.verdict)).toEqual(['asked'])
  })

  test('an ask the person refuses reads denied, and the refusal is logged once', () => {
    const log = createSessionLog()
    const input = { command: 'rm -rf build' }

    log.toolChecked({ id: 'a', tool: 'Bash', input, decision: 'ask', nowMs: T0 })
    expect(log.view(T0).log).toEqual([])
    log.toolFinished({ id: 'a', tool: 'Bash', input, isDenied: true, nowMs: T0 + 3000 })

    const view = log.view(T0 + 3000)

    expect(view.gate.map(check => check.verdict)).toEqual(['denied'])
    expect(view.log).toEqual([{ at: T0 + 3000, kind: 'denied', who: 'main', text: 'Bash rm -rf build', agentId: null }])
  })

  test('a call denied at the check reads denied at once and is logged once, however the call then settles', () => {
    const log = createSessionLog()
    const input = { command: 'git push --force' }

    log.toolChecked({ id: 'a', tool: 'Bash', input, decision: 'deny', nowMs: T0 })
    expect(log.view(T0).gate.map(check => check.verdict)).toEqual(['denied'])
    expect(log.view(T0).log).toEqual([{ at: T0, kind: 'denied', who: 'main', text: 'Bash git push --force', agentId: null }])
    log.toolFinished({ id: 'a', tool: 'Bash', input, isDenied: true, nowMs: T0 + 5 })

    log.toolChecked({ id: 'b', tool: 'Bash', input, decision: 'deny', nowMs: T0 + 10 })
    // the engine may report the refusal as an error result instead
    log.toolFinished({ id: 'b', tool: 'Bash', input, isError: true, nowMs: T0 + 15 })

    const view = log.view(T0 + 20)

    expect(view.log.map(entry => entry.kind)).toEqual(['denied', 'denied'])
    expect(view.gate.map(check => check.verdict)).toEqual(['denied', 'denied'])
  })

  test('a second check that denies the same call logs the refusal once', () => {
    const log = createSessionLog()

    log.toolChecked({ id: 'a', tool: 'Bash', input: { command: 'git push --force' }, decision: 'deny', nowMs: T0 })
    log.toolChecked({ id: 'a', tool: 'Bash', input: { command: 'git push --force' }, decision: 'deny', nowMs: T0 + 1 })

    const view = log.view(T0 + 1)

    expect(view.gate.map(check => [check.verdict, check.at])).toEqual([['denied', T0 + 1]])
    expect(view.log).toHaveLength(1)
  })

  test('a rule verdict is not rewritten by how the call ended', () => {
    const log = createSessionLog()

    log.toolChecked({ id: 'a', tool: 'Read', input: { file_path: '/repo/a.ts' }, decision: 'allow', nowMs: T0 })
    log.toolFinished({ id: 'a', tool: 'Read', input: { file_path: '/repo/a.ts' }, isError: true, nowMs: T0 + 5 })
    expect(log.view(T0 + 5).gate.map(check => check.verdict)).toEqual(['rule'])
  })

  test('says when the call was made inside a subagent', () => {
    const log = createSessionLog()

    log.toolChecked({ id: 'a', tool: 'Grep', input: { pattern: 'retry' }, decision: 'allow', agentId: 'agent-1', nowMs: T0 })
    log.toolChecked({ id: 'b', tool: 'Grep', input: { pattern: 'retry' }, decision: 'allow', nowMs: T0 })
    expect(log.view(T0).gate.map(check => check.inSubagent)).toEqual([true, false])
  })

  test('masks secrets in the detail', () => {
    const log = createSessionLog()

    log.toolChecked({ id: 'a', tool: 'Bash', input: { command: `deploy --token=${fake('ghp_', 36)}` }, decision: 'ask', nowMs: T0 })
    expect(log.view(T0).gate[0]?.detail).toBe('deploy --token=•••')
  })

  test('the check and the start of a call may come in either order', () => {
    const log = createSessionLog()

    log.toolChecked({ id: 'a', tool: MCP, input: { query: 'mods' }, decision: 'ask', nowMs: T0 })
    log.toolStarted({ id: 'a', tool: MCP, input: { query: 'mods' }, nowMs: T0 + 1 })
    log.toolFinished({ id: 'a', tool: MCP, input: { query: 'mods' }, nowMs: T0 + 400 })
    expect(log.view(T0 + 400).gate.map(check => check.verdict)).toEqual(['asked'])
    expect(log.view(T0 + 400).mcp[0]?.lastMs).toBe(399)
  })

  test('a second check of one call replaces its row', () => {
    const log = createSessionLog()

    log.toolChecked({ id: 'a', tool: 'Bash', input: { command: 'ls' }, decision: 'ask', nowMs: T0 })
    log.toolChecked({ id: 'b', tool: 'Bash', input: { command: 'pwd' }, decision: 'allow', nowMs: T0 + 1 })
    log.toolChecked({ id: 'a', tool: 'Bash', input: { command: 'ls' }, decision: 'allow', nowMs: T0 + 2 })

    const gate = log.view(T0 + 2).gate

    expect(gate.map(check => [check.id, check.verdict, check.at])).toEqual([
      ['a', 'rule', T0 + 2],
      ['b', 'rule', T0 + 1],
    ])
  })

  test('keeps the newest 60 checks, newest last', () => {
    const log = createSessionLog()

    for (let index = 0; index < 100; index += 1) {
      log.toolChecked({ id: `c${index}`, tool: 'Read', input: { file_path: `/repo/${index}.ts` }, decision: 'allow', nowMs: T0 + index })
    }

    const gate = log.view(T0 + 100).gate

    expect(gate).toHaveLength(60)
    expect(gate[0]?.id).toBe('c40')
    expect(gate[59]?.id).toBe('c99')
  })

  test('settling a call the gate no longer holds changes nothing', () => {
    const log = createSessionLog()

    log.toolChecked({ id: 'old', tool: 'Bash', input: { command: 'ls' }, decision: 'ask', nowMs: T0 })
    for (let index = 0; index < 60; index += 1) {
      log.toolChecked({ id: `c${index}`, tool: 'Read', decision: 'allow', nowMs: T0 + 1 + index })
    }
    log.toolFinished({ id: 'old', tool: 'Bash', input: { command: 'ls' }, nowMs: T0 + 100 })
    log.toolFinished({ id: 'never-seen', tool: 'Bash', isDenied: true, nowMs: T0 + 101 })

    const gate = log.view(T0 + 101).gate

    expect(gate).toHaveLength(60)
    expect(gate.every(check => check.verdict === 'rule')).toBe(true)
  })

  test('settles each pending ask by its own id', () => {
    const log = createSessionLog()

    for (const id of ['a', 'b', 'c']) {
      log.toolChecked({ id, tool: 'Bash', input: { command: id }, decision: 'ask', nowMs: T0 })
    }
    log.toolFinished({ id: 'b', tool: 'Bash', input: { command: 'b' }, isDenied: true, nowMs: T0 + 1 })
    log.toolFinished({ id: 'c', tool: 'Bash', input: { command: 'c' }, nowMs: T0 + 2 })
    expect(log.view(T0 + 2).gate.map(check => [check.id, check.verdict])).toEqual([
      ['a', 'pending'],
      ['b', 'denied'],
      ['c', 'asked'],
    ])
  })
})

describe('MCP servers', () => {
  test('a call goes in flight on its server as it starts', () => {
    const log = createSessionLog()

    log.toolStarted({ id: 'c1', tool: MCP, input: { query: 'mods' }, nowMs: T0 })
    expect(log.view(T0 + 500).mcp).toEqual([
      {
        server: 'docs',
        calls: 1,
        timedCalls: 0,
        errors: 0,
        subagentCalls: 0,
        totalMs: 0,
        maxMs: 0,
        lastMs: null,
        lastTool: 'search',
        lastAt: null,
        inFlight: [{ id: 'c1', tool: 'search', startedAt: T0 }],
      },
    ])
  })

  test('a finished call leaves the flight, and its time, its end and the longest call are kept', () => {
    const log = createSessionLog()

    run(log, { id: 'c1', tool: MCP }, T0, 340)
    expect(log.view(T0 + 340).mcp).toEqual([
      {
        server: 'docs',
        calls: 1,
        timedCalls: 1,
        errors: 0,
        subagentCalls: 0,
        totalMs: 340,
        maxMs: 340,
        lastMs: 340,
        lastTool: 'search',
        lastAt: T0 + 340,
        inFlight: [],
      },
    ])
    run(log, { id: 'c2', tool: 'mcp__docs__fetch' }, T0 + 1000, 2000)
    run(log, { id: 'c3', tool: MCP }, T0 + 4000, 100)

    expect(log.view(T0 + 4100).mcp[0]).toMatchObject({
      calls: 3,
      totalMs: 2440,
      maxMs: 2000,
      lastMs: 100,
      lastTool: 'search',
      lastAt: T0 + 4100,
    })
  })

  test('a failed call counts an error and still takes its time', () => {
    const log = createSessionLog()

    run(log, { id: 'c1', tool: MCP, isError: true, result: 'boom' }, T0, 50)
    run(log, { id: 'c2', tool: MCP }, T0 + 100, 70)
    expect(log.view(T0 + 200).mcp[0]).toMatchObject({ calls: 2, errors: 1, totalMs: 120, maxMs: 70, lastMs: 70 })
  })

  test('calls made inside a subagent are counted apart', () => {
    const log = createSessionLog()

    run(log, { id: 'c1', tool: MCP }, T0)
    run(log, { id: 'c2', tool: MCP, agentId: 'agent-1' }, T0 + 20)
    run(log, { id: 'c3', tool: 'mcp__docs__fetch', agentId: 'agent-2' }, T0 + 40)
    expect(log.view(T0 + 100).mcp[0]).toMatchObject({ calls: 3, subagentCalls: 2 })
  })

  test('calls in flight together settle one by one, by id', () => {
    const log = createSessionLog()

    log.toolStarted({ id: 'c1', tool: MCP, nowMs: T0 })
    log.toolStarted({ id: 'c2', tool: 'mcp__docs__fetch', nowMs: T0 + 100 })
    expect(log.view(T0 + 200).mcp[0]?.inFlight).toEqual([
      { id: 'c1', tool: 'search', startedAt: T0 },
      { id: 'c2', tool: 'fetch', startedAt: T0 + 100 },
    ])
    log.toolFinished({ id: 'c2', tool: 'mcp__docs__fetch', nowMs: T0 + 300 })
    expect(log.view(T0 + 300).mcp[0]).toMatchObject({
      inFlight: [{ id: 'c1', tool: 'search', startedAt: T0 }],
      lastMs: 200,
      lastTool: 'fetch',
    })
    log.toolFinished({ id: 'c1', tool: MCP, nowMs: T0 + 900 })
    expect(log.view(T0 + 900).mcp[0]).toMatchObject({ inFlight: [], lastMs: 900, maxMs: 900, totalMs: 1100 })
  })

  test('a refused call leaves the flight with no time and no error', () => {
    const log = createSessionLog()

    log.toolStarted({ id: 'c1', tool: MCP, nowMs: T0 })
    log.toolFinished({ id: 'c1', tool: MCP, isDenied: true, nowMs: T0 + 5000 })
    expect(log.view(T0 + 5000).mcp[0]).toEqual({
      server: 'docs',
      calls: 1,
      timedCalls: 0,
      errors: 0,
      subagentCalls: 0,
      totalMs: 0,
      maxMs: 0,
      lastMs: null,
      lastTool: 'search',
      lastAt: null,
      inFlight: [],
    })
  })

  test('a call that never began is ignored when it ends', () => {
    const log = createSessionLog()

    log.toolFinished({ id: 'ghost', tool: MCP, isError: true, nowMs: T0 })
    expect(log.view(T0).mcp).toEqual([])

    run(log, { id: 'c1', tool: MCP }, T0 + 10, 30)
    log.toolFinished({ id: 'ghost', tool: MCP, isError: true, nowMs: T0 + 100 })
    expect(log.view(T0 + 100).mcp[0]).toMatchObject({ calls: 1, errors: 0, totalMs: 30, lastAt: T0 + 40 })
  })

  test('time never runs backwards', () => {
    const log = createSessionLog()

    log.toolStarted({ id: 'c1', tool: MCP, nowMs: T0 + 500 })
    log.toolFinished({ id: 'c1', tool: MCP, nowMs: T0 })
    expect(log.view(T0).mcp[0]).toMatchObject({ lastMs: 0, totalMs: 0, maxMs: 0 })
  })

  test('lists servers by calls, then by name, and splits a tool name at the first __ after the server', () => {
    const log = createSessionLog()

    run(log, { id: '1', tool: 'mcp__zeta__a' }, T0)
    run(log, { id: '2', tool: 'mcp__alpha__b' }, T0)
    run(log, { id: '3', tool: 'mcp__my_server__do__thing' }, T0)
    for (const id of ['4', '5', '6']) {
      run(log, { id, tool: 'mcp__docs__x' }, T0)
    }

    const mcp = log.view(T0).mcp

    expect(mcp.map(server => [server.server, server.calls])).toEqual([
      ['docs', 3],
      ['alpha', 1],
      ['my_server', 1],
      ['zeta', 1],
    ])
    expect(mcp.find(server => server.server === 'my_server')?.lastTool).toBe('do__thing')
  })

  test('other tools make no server, and a name that is no MCP tool is only tallied', () => {
    const log = createSessionLog()

    run(log, { id: '1', tool: 'Bash' }, T0)
    run(log, { id: '2', tool: 'Agent' }, T0)
    run(log, { id: '3', tool: 'mcp__docs' }, T0)

    const view = log.view(T0)

    expect(view.mcp).toEqual([])
    expect(view.tools.map(tool => tool.name).sort()).toEqual(['Agent', 'Bash', 'mcp__docs'])
  })
})

describe("an MCP call's own duration", () => {
  /** The figures of the one server the duration changes. */
  const timing = (log: SessionLog) => {
    const server = log.view(T0).mcp[0]

    return { totalMs: server?.totalMs, maxMs: server?.maxMs, lastMs: server?.lastMs, timedCalls: server?.timedCalls }
  }

  test('one that arrives before the call settles is used instead of the wall time', () => {
    const log = createSessionLog()

    log.toolStarted({ id: 'c1', tool: MCP, nowMs: T0 })
    // The tool took 120 ms; the person took five seconds to answer the permission prompt.
    log.mcpTimed({ id: 'c1', ms: 120 })
    log.toolFinished({ id: 'c1', tool: MCP, nowMs: T0 + 5000 })
    expect(timing(log)).toEqual({ totalMs: 120, maxMs: 120, lastMs: 120, timedCalls: 1 })
  })

  test('one that arrives after the call settled replaces the wall time in the total, the last call and the longest', () => {
    const log = createSessionLog()

    run(log, { id: 'c1', tool: MCP }, T0, 5000)
    expect(timing(log)).toEqual({ totalMs: 5000, maxMs: 5000, lastMs: 5000, timedCalls: 1 })
    log.mcpTimed({ id: 'c1', ms: 120 })
    expect(timing(log)).toEqual({ totalMs: 120, maxMs: 120, lastMs: 120, timedCalls: 1 })
  })

  test('replaces a call once: a second duration for it changes nothing', () => {
    const log = createSessionLog()

    run(log, { id: 'c1', tool: MCP }, T0, 5000)
    log.mcpTimed({ id: 'c1', ms: 120 })
    log.mcpTimed({ id: 'c1', ms: 7 })
    expect(timing(log)).toEqual({ totalMs: 120, maxMs: 120, lastMs: 120, timedCalls: 1 })
  })

  test('replaces the right call among several, by id', () => {
    const log = createSessionLog()

    run(log, { id: 'c1', tool: MCP }, T0, 2000)
    run(log, { id: 'c2', tool: MCP }, T0 + 3000, 3000)
    run(log, { id: 'c3', tool: MCP }, T0 + 7000, 1000)
    log.mcpTimed({ id: 'c2', ms: 400 })
    expect(timing(log)).toEqual({ totalMs: 3400, maxMs: 2000, lastMs: 1000, timedCalls: 3 })
    log.mcpTimed({ id: 'c3', ms: 300 })
    expect(timing(log)).toEqual({ totalMs: 2700, maxMs: 2000, lastMs: 300, timedCalls: 3 })
    log.mcpTimed({ id: 'c1', ms: 600 })
    expect(timing(log)).toEqual({ totalMs: 1300, maxMs: 600, lastMs: 300, timedCalls: 3 })
  })

  test('the longest call replaced by a shorter time leaves the next longest, however the durations arrive', () => {
    // c1 waited 2 s on wall time, c2 8 s (a permission prompt); their own times are 500 ms and 300 ms.
    const arrivals: [string, string[]][] = [
      ['the longest by wall time last', ['c1', 'c2']],
      ['the longest by wall time first', ['c2', 'c1']],
    ]

    for (const [name, order] of arrivals) {
      const log = createSessionLog()
      const own: Record<string, number> = { c1: 500, c2: 300 }

      run(log, { id: 'c1', tool: MCP }, T0, 2000)
      run(log, { id: 'c2', tool: MCP }, T0 + 3000, 8000)
      for (const id of order) {
        log.mcpTimed({ id, ms: own[id] ?? 0 })
      }
      expect(timing(log), name).toEqual({ totalMs: 800, maxMs: 500, lastMs: 300, timedCalls: 2 })
    }
  })

  test('the longest call replaced by a shorter time leaves the next longest, also when that one used its own time at once', () => {
    const log = createSessionLog()

    log.toolStarted({ id: 'c1', tool: MCP, nowMs: T0 })
    log.mcpTimed({ id: 'c1', ms: 500 })
    log.toolFinished({ id: 'c1', tool: MCP, nowMs: T0 + 2000 })
    run(log, { id: 'c2', tool: MCP }, T0 + 3000, 8000)
    expect(timing(log)).toEqual({ totalMs: 8500, maxMs: 8000, lastMs: 8000, timedCalls: 2 })
    log.mcpTimed({ id: 'c2', ms: 300 })
    expect(timing(log)).toEqual({ totalMs: 800, maxMs: 500, lastMs: 300, timedCalls: 2 })
  })

  test('a call that tied the longest on wall time does not take the longest with it', () => {
    const log = createSessionLog()

    run(log, { id: 'c1', tool: MCP }, T0, 3000)
    run(log, { id: 'c2', tool: MCP }, T0 + 4000, 3000)
    log.mcpTimed({ id: 'c1', ms: 200 })
    log.mcpTimed({ id: 'c2', ms: 100 })
    expect(timing(log)).toEqual({ totalMs: 300, maxMs: 200, lastMs: 100, timedCalls: 2 })
  })

  test('the last call is the one that settled last, whatever the others took', () => {
    const log = createSessionLog()

    // Two calls with the same wall time: the first one is corrected, and that is not the last call.
    run(log, { id: 'c1', tool: MCP }, T0, 1000)
    run(log, { id: 'c2', tool: MCP }, T0 + 2000, 1000)
    log.mcpTimed({ id: 'c1', ms: 200 })
    expect(timing(log)).toEqual({ totalMs: 1200, maxMs: 1000, lastMs: 1000, timedCalls: 2 })
    log.mcpTimed({ id: 'c2', ms: 150 })
    expect(timing(log)).toEqual({ totalMs: 350, maxMs: 200, lastMs: 150, timedCalls: 2 })
  })

  test('the longest stays right when its wall time is long forgotten', () => {
    const log = createSessionLog()

    // The first call is the longest; a hundred more settle after it, which is as many as are waiting for a duration.
    run(log, { id: 'long', tool: MCP }, T0, 9000)
    for (let n = 1; n <= 100; n += 1) {
      run(log, { id: `c${n}`, tool: MCP }, T0 + 10_000 + n * 1000, 100)
    }
    // The first one cannot be corrected any more, and its time stands; a later one still can.
    log.mcpTimed({ id: 'long', ms: 50 })
    log.mcpTimed({ id: 'c100', ms: 20 })
    expect(timing(log)).toEqual({ totalMs: 9000 + 99 * 100 + 20, maxMs: 9000, lastMs: 20, timedCalls: 101 })
  })

  test('each server has its own figures', () => {
    const log = createSessionLog()

    run(log, { id: 'a1', tool: 'mcp__docs__search' }, T0, 4000)
    run(log, { id: 'b1', tool: 'mcp__tickets__find' }, T0 + 5000, 900)
    log.mcpTimed({ id: 'a1', ms: 80 })
    expect(log.view(T0).mcp.map(server => [server.server, server.totalMs, server.maxMs, server.lastMs])).toEqual([
      ['docs', 80, 80, 80],
      ['tickets', 900, 900, 900],
    ])
  })

  test('a duration that is no time is ignored, and the call counts its wall time', () => {
    const log = createSessionLog()

    log.toolStarted({ id: 'c1', tool: MCP, nowMs: T0 })
    for (const ms of [Number.NaN, Number.POSITIVE_INFINITY, -5]) {
      log.mcpTimed({ id: 'c1', ms })
    }
    log.toolFinished({ id: 'c1', tool: MCP, nowMs: T0 + 700 })
    log.mcpTimed({ id: 'c1', ms: Number.NaN })
    log.mcpTimed({ id: 'c1', ms: -1 })
    expect(timing(log)).toEqual({ totalMs: 700, maxMs: 700, lastMs: 700, timedCalls: 1 })
  })

  test('a duration for a refused call, or a call that never began, changes nothing', () => {
    const log = createSessionLog()

    log.toolStarted({ id: 'c1', tool: MCP, nowMs: T0 })
    log.mcpTimed({ id: 'c1', ms: 90 })
    log.toolFinished({ id: 'c1', tool: MCP, isDenied: true, nowMs: T0 + 3000 })
    log.mcpTimed({ id: 'ghost', ms: 10 })
    expect(timing(log)).toEqual({ totalMs: 0, maxMs: 0, lastMs: null, timedCalls: 0 })
  })

  test('is forgotten on reset: nothing noted before it reaches a call after it', () => {
    const log = createSessionLog()

    // A call that used its own time at once (the longest, 900 ms), a duration whose call has not come, and a call still on wall time.
    log.toolStarted({ id: 'c0', tool: MCP, nowMs: T0 })
    log.mcpTimed({ id: 'c0', ms: 900 })
    log.toolFinished({ id: 'c0', tool: MCP, nowMs: T0 + 50 })
    log.mcpTimed({ id: 'c1', ms: 90 })
    run(log, { id: 'c2', tool: MCP }, T0 + 100, 400)
    log.reset()

    log.toolStarted({ id: 'c1', tool: MCP, nowMs: T0 + 1000 })
    log.toolFinished({ id: 'c1', tool: MCP, nowMs: T0 + 1500 })
    expect(timing(log)).toEqual({ totalMs: 500, maxMs: 500, lastMs: 500, timedCalls: 1 })
    // The call settled before the reset cannot be corrected after it.
    log.mcpTimed({ id: 'c2', ms: 5 })
    expect(timing(log)).toEqual({ totalMs: 500, maxMs: 500, lastMs: 500, timedCalls: 1 })
    // And the longest of before is not the longest of now.
    log.mcpTimed({ id: 'c1', ms: 100 })
    expect(timing(log)).toEqual({ totalMs: 100, maxMs: 100, lastMs: 100, timedCalls: 1 })
  })
})

describe('tool tally', () => {
  test('counts every tool by name, the most used first, ties by name', () => {
    const log = createSessionLog()
    const used = ['Bash', 'Read', MCP, 'Bash', 'Agent', 'Read', 'Bash', MCP]

    used.forEach((tool, index) => log.toolStarted({ id: `c${index}`, tool, nowMs: T0 + index }))
    expect(log.view(T0).tools).toEqual([
      { name: 'Bash', count: 3 },
      { name: 'Read', count: 2 },
      { name: MCP, count: 2 },
      { name: 'Agent', count: 1 },
    ])
  })

  test('counts calls from subagents too', () => {
    const log = createSessionLog()

    log.toolStarted({ id: 'a', tool: 'Grep', agentId: 'agent-1', nowMs: T0 })
    log.toolStarted({ id: 'b', tool: 'Grep', nowMs: T0 })
    expect(log.view(T0).tools).toEqual([{ name: 'Grep', count: 2 }])
  })
})

describe('subagent cards', () => {
  test('a spawn makes a running card and logs it', () => {
    const log = createSessionLog()

    spawn(log, 'agent-1', T0)

    const view = log.view(T0 + 1000)

    expect(view.agents).toEqual([
      {
        id: 'agent-1',
        type: 'Explore',
        description: 'Find the auth code',
        model: 'claude-sonnet-5-5',
        status: 'running',
        startedAt: T0,
        endedAt: null,
        steps: 0,
        contextTokens: 0,
        outputTokens: 0,
        tools: [],
        answer: '',
      },
    ])
    expect(view.log).toEqual([{ at: T0, kind: 'spawn', who: 'Find the auth…', text: 'spawned · Explore', agentId: 'agent-1' }])
  })

  test('every step adds a step, sets the context to the whole input of that request and adds up the output', () => {
    const log = createSessionLog()

    spawn(log, 'agent-1', T0)
    log.agentStepped({
      agentId: 'agent-1',
      usage: { input_tokens: 100, cache_read_input_tokens: 4000, cache_creation_input_tokens: 500, output_tokens: 40 },
      stopReason: 'tool_use',
      nowMs: T0 + 1000,
    })
    expect(log.view(T0 + 1000).agents[0]).toMatchObject({ steps: 1, contextTokens: 4600, outputTokens: 40 })
    log.agentStepped({
      agentId: 'agent-1',
      usage: { input_tokens: 120, cache_read_input_tokens: 4500, cache_creation_input_tokens: 0, output_tokens: 60 },
      stopReason: 'end_turn',
      nowMs: T0 + 2000,
    })
    expect(log.view(T0 + 2000).agents[0]).toMatchObject({ steps: 2, contextTokens: 4620, outputTokens: 100, status: 'running' })
  })

  test('a request that reports nothing still counts as a step but keeps the context it had', () => {
    const log = createSessionLog()

    spawn(log, 'agent-1', T0)
    log.agentStepped({ agentId: 'agent-1', usage: { input_tokens: 900, output_tokens: 10 }, stopReason: 'tool_use', nowMs: T0 + 1 })
    log.agentStepped({ agentId: 'agent-1', usage: null, stopReason: null, nowMs: T0 + 2 })
    log.agentStepped({ agentId: 'agent-1', usage: { input_tokens: 0, output_tokens: 0 }, nowMs: T0 + 3 })
    log.agentStepped({ agentId: 'agent-1', nowMs: T0 + 4 })
    expect(log.view(T0 + 4).agents[0]).toMatchObject({ steps: 4, contextTokens: 900, outputTokens: 10 })
  })

  test('a step that stopped on max_tokens is logged as an error against the agent', () => {
    const log = createSessionLog()

    spawn(log, 'agent-1', T0)
    log.agentStepped({ agentId: 'agent-1', usage: { output_tokens: 8000 }, stopReason: 'max_tokens', nowMs: T0 + 9000 })
    expect(log.view(T0 + 9000).log[1]).toEqual({
      at: T0 + 9000,
      kind: 'error',
      who: 'Find the auth…',
      text: 'hit max_tokens',
      agentId: 'agent-1',
    })
    log.agentStepped({ agentId: 'agent-1', stopReason: 'end_turn', nowMs: T0 + 9100 })
    expect(log.view(T0 + 9100).log).toHaveLength(2)
  })

  test('keeps its last three tool calls, newest last, and flags the ones that failed or were refused', () => {
    const log = createSessionLog()

    spawn(log, 'agent-1', T0)
    run(log, { id: 't1', tool: 'Read', agentId: 'agent-1', input: { file_path: '/repo/a.ts' } }, T0 + 10)
    run(log, { id: 't2', tool: 'Grep', agentId: 'agent-1', input: { pattern: 'retry', path: 'src' } }, T0 + 20)
    run(log, { id: 't3', tool: 'Bash', agentId: 'agent-1', input: { command: 'npm test' }, isError: true }, T0 + 30)
    run(log, { id: 't4', tool: 'Bash', agentId: 'agent-1', input: { command: 'rm -rf build' }, isDenied: true }, T0 + 40)
    expect(log.view(T0 + 50).agents[0]?.tools).toEqual([
      { tool: 'Grep', text: 'retry in src', isError: false },
      { tool: 'Bash', text: 'npm test', isError: true },
      { tool: 'Bash', text: 'rm -rf build', isError: true },
    ])
  })

  test('cuts the tool text to 64 characters and masks it', () => {
    const log = createSessionLog()

    spawn(log, 'agent-1', T0)
    run(log, { id: 't1', tool: 'Bash', agentId: 'agent-1', input: { command: `deploy --token ${fake('ghp_', 36)}` } }, T0 + 10)
    run(log, { id: 't2', tool: 'Bash', agentId: 'agent-1', input: { command: `echo ${'z'.repeat(200)}` } }, T0 + 20)

    const tools = log.view(T0 + 30).agents[0]?.tools

    expect(tools?.[0]?.text).toBe('deploy --token •••')
    expect(tools?.[1]?.text).toHaveLength(64)
    expect(tools?.[1]?.text.endsWith('…')).toBe(true)
  })

  test('calls of an agent with no card are not noted', () => {
    const log = createSessionLog()

    run(log, { id: 't1', tool: 'Read', agentId: 'stranger', input: { file_path: '/repo/a.ts' } }, T0)
    expect(log.view(T0).agents).toEqual([])
  })

  test('an answer ends the card as done, with the start of the answer on one line', () => {
    const log = createSessionLog()

    spawn(log, 'agent-1', T0)
    log.turnCompleted({
      agentId: 'agent-1',
      reason: 'answer',
      answer: 'The auth code lives in src/auth.\n\nIt has two parts.',
      durationMs: 65_000,
      nowMs: T0 + 65_000,
    })

    const view = log.view(T0 + 70_000)

    expect(view.agents[0]).toMatchObject({
      status: 'done',
      endedAt: T0 + 65_000,
      answer: 'The auth code lives in src/auth. It has two parts.',
    })
    expect(view.log[1]).toEqual({ at: T0 + 65_000, kind: 'done', who: 'Find the auth…', text: 'done · 1m05s', agentId: 'agent-1' })
  })

  test('cuts the answer to 400 characters and masks it', () => {
    const log = createSessionLog()

    spawn(log, 'agent-1', T0)
    log.turnCompleted({ agentId: 'agent-1', reason: 'answer', answer: `${'z'.repeat(1000)}`, durationMs: 1, nowMs: T0 + 1 })
    expect(log.view(T0 + 1).agents[0]?.answer).toHaveLength(400)

    spawn(log, 'agent-2', T0 + 2)
    log.turnCompleted({
      agentId: 'agent-2',
      reason: 'answer',
      answer: `Use password=hunter2 and ${fake('ghp_', 36)}`,
      durationMs: 1,
      nowMs: T0 + 3,
    })
    expect(log.view(T0 + 3).agents.find(card => card.id === 'agent-2')?.answer).toBe('Use password=••• and •••')
  })

  test('an interrupt stops the card, an error or a refusal fails it, and both are logged as errors', () => {
    const log = createSessionLog()

    for (const [id, reason] of [
      ['a', 'aborted'],
      ['b', 'error'],
      ['c', 'refusal'],
    ] as const) {
      spawn(log, id, T0)
      finishAgent(log, id, T0 + 12_000, reason, 'partial')
    }

    const view = log.view(T0 + 12_000)
    const status = (id: string) => view.agents.find(card => card.id === id)?.status

    expect([status('a'), status('b'), status('c')]).toEqual(['stopped', 'failed', 'failed'])
    expect(view.log.filter(entry => entry.kind === 'error').map(entry => entry.text)).toEqual([
      'stopped · 12s',
      'failed · 12s',
      'failed · 12s',
    ])
  })

  test('logs how long a long run took', () => {
    const log = createSessionLog()

    spawn(log, 'agent-1', T0)
    finishAgent(log, 'agent-1', T0 + 3_720_000)
    expect(log.view(T0).log[1]?.text).toBe('done · 1h02m')
  })

  test('names the card in the log by its description, else its type, cut to 14', () => {
    const log = createSessionLog()

    spawn(log, 'a', T0, { description: '', type: 'general-purpose' })
    spawn(log, 'b', T0, { description: 'Review', type: 'reviewer' })
    expect(log.view(T0).log.map(entry => entry.who)).toEqual(['general-purpo…', 'Review'])
  })

  test('a spawn of an id the tracker holds replaces its card', () => {
    const log = createSessionLog()

    spawn(log, 'agent-1', T0)
    log.agentStepped({ agentId: 'agent-1', usage: { input_tokens: 10, output_tokens: 5 }, nowMs: T0 + 1 })
    finishAgent(log, 'agent-1', T0 + 2)
    spawn(log, 'agent-1', T0 + 10, { description: 'Second run' })

    const agents = log.view(T0 + 10).agents

    expect(agents).toHaveLength(1)
    expect(agents[0]).toMatchObject({
      description: 'Second run',
      status: 'running',
      steps: 0,
      startedAt: T0 + 10,
      endedAt: null,
      answer: '',
    })
  })

  test('a step after the end means the agent runs again, so its card does too', () => {
    const log = createSessionLog()

    spawn(log, 'agent-1', T0)
    finishAgent(log, 'agent-1', T0 + 1000, 'answer', 'First answer')
    expect(log.view(T0 + 1000).agents[0]).toMatchObject({ status: 'done', answer: 'First answer' })
    log.agentStepped({ agentId: 'agent-1', usage: { input_tokens: 50, output_tokens: 5 }, nowMs: T0 + 5000 })
    expect(log.view(T0 + 5000).agents[0]).toMatchObject({ status: 'running', endedAt: null, answer: '', steps: 1 })
    finishAgent(log, 'agent-1', T0 + 6000, 'answer', 'Second answer')
    expect(log.view(T0 + 6000).agents[0]).toMatchObject({ status: 'done', endedAt: T0 + 6000, answer: 'Second answer' })
  })

  test('an end that repeats once the card has ended changes nothing', () => {
    const log = createSessionLog()

    spawn(log, 'agent-1', T0)
    finishAgent(log, 'agent-1', T0 + 1000, 'answer', 'First')
    finishAgent(log, 'agent-1', T0 + 2000, 'error', 'Second')
    expect(log.view(T0 + 2000).agents[0]).toMatchObject({ status: 'done', endedAt: T0 + 1000, answer: 'First' })
    expect(log.view(T0 + 2000).log).toHaveLength(2)
  })

  test('an agent that ended before its spawn was noted still ends when its card is made', () => {
    const log = createSessionLog()

    finishAgent(log, 'agent-1', T0 + 400, 'error', 'could not start')
    expect(log.view(T0 + 400).agents).toEqual([])
    spawn(log, 'agent-1', T0 + 500)

    const view = log.view(T0 + 500)

    expect(view.agents[0]).toMatchObject({ status: 'failed', startedAt: T0 + 500, endedAt: T0 + 500, answer: 'could not start' })
    expect(view.log.map(entry => entry.kind)).toEqual(['spawn', 'error'])
  })

  test('an end that came early applies to the first card of that id only', () => {
    const log = createSessionLog()

    finishAgent(log, 'agent-1', T0 + 400, 'error', 'could not start')
    spawn(log, 'agent-1', T0 + 500)
    spawn(log, 'agent-1', T0 + 900)

    const agents = log.view(T0 + 900).agents

    expect(agents).toHaveLength(1)
    expect(agents[0]).toMatchObject({ status: 'running', startedAt: T0 + 900, endedAt: null, answer: '' })
  })

  test('remembers the ends of the last 24 unknown agents, no more', () => {
    const log = createSessionLog()

    for (let index = 0; index < 30; index += 1) {
      finishAgent(log, `u${index}`, T0 + index)
    }
    spawn(log, 'u0', T0 + 100)
    spawn(log, 'u29', T0 + 101)

    const status = (id: string) => log.view(T0 + 101).agents.find(card => card.id === id)?.status

    expect([status('u0'), status('u29')]).toEqual(['running', 'done'])
  })

  test('cuts a long description to 120 characters and masks a secret in it', () => {
    const log = createSessionLog()

    spawn(log, 'agent-1', T0, { description: `Deploy with token=hunter2 ${'z'.repeat(300)}` })

    const description = log.view(T0).agents[0]?.description ?? ''

    expect(description.startsWith('Deploy with token=••• zzz')).toBe(true)
    expect(description).toHaveLength(120)
    expect(description.endsWith('…')).toBe(true)
  })

  test('steps and ends of an agent the tracker never saw spawn are ignored', () => {
    const log = createSessionLog()

    log.agentStepped({ agentId: 'stranger', usage: { input_tokens: 10, output_tokens: 1 }, stopReason: 'max_tokens', nowMs: T0 })
    expect(log.view(T0).agents).toEqual([])
    expect(log.view(T0).log).toEqual([])
  })

  test('lists running agents first, then the newest first', () => {
    const log = createSessionLog()

    spawn(log, 'x', T0)
    spawn(log, 'y', T0 + 10)
    spawn(log, 'z', T0 + 20)
    finishAgent(log, 'y', T0 + 30)
    expect(log.view(T0 + 30).agents.map(card => card.id)).toEqual(['z', 'x', 'y'])
    spawn(log, 'w', T0 + 40)
    finishAgent(log, 'x', T0 + 50)
    // finished cards keep the order of their spawns, not of their ends
    expect(log.view(T0 + 50).agents.map(card => card.id)).toEqual(['w', 'z', 'y', 'x'])
  })

  test('agents spawned in the same millisecond list the later spawn first', () => {
    const log = createSessionLog()

    spawn(log, 'first', T0)
    spawn(log, 'second', T0)
    expect(log.view(T0).agents.map(card => card.id)).toEqual(['second', 'first'])
  })

  test('holds 24 cards: the one that finished longest ago goes first', () => {
    const log = createSessionLog()

    for (let index = 1; index <= 24; index += 1) {
      spawn(log, `a${index}`, T0 + index * 10)
    }
    finishAgent(log, 'a10', T0 + 1000)
    finishAgent(log, 'a5', T0 + 2000)
    finishAgent(log, 'a3', T0 + 3000)
    spawn(log, 'a25', T0 + 5000)

    const ids = () => log.view(T0 + 5000).agents.map(card => card.id)

    expect(ids()).toHaveLength(24)
    expect(ids()).toContain('a25')
    expect(ids()).not.toContain('a10')
    expect(ids()).toContain('a5')
    expect(ids()).toContain('a3')
    spawn(log, 'a26', T0 + 5010)
    expect(ids()).not.toContain('a5')
    spawn(log, 'a27', T0 + 5020)
    expect(ids()).not.toContain('a3')
    expect(ids()).toContain('a1')
    expect(ids()).toHaveLength(24)
  })

  test('when all 24 still run, the oldest running card goes', () => {
    const log = createSessionLog()

    for (let index = 1; index <= 25; index += 1) {
      spawn(log, `a${index}`, T0 + index)
    }

    const ids = log.view(T0 + 100).agents.map(card => card.id)

    expect(ids).toHaveLength(24)
    expect(ids).not.toContain('a1')
    expect(ids).toContain('a2')
    expect(ids).toContain('a25')
  })
})

describe('foreground and background agents', () => {
  const brief = { description: 'Find the auth code' }

  test('a foreground agent ends before its Agent call returns, and the call changes nothing', () => {
    const log = createSessionLog()

    log.toolStarted({ id: 'call-1', tool: 'Agent', input: brief, nowMs: T0 })
    log.toolChecked({ id: 'call-1', tool: 'Agent', input: brief, decision: 'allow', nowMs: T0 + 1 })
    spawn(log, 'agent-1', T0 + 100)
    log.agentStepped({ agentId: 'agent-1', usage: { input_tokens: 10, output_tokens: 5 }, nowMs: T0 + 500 })
    finishAgent(log, 'agent-1', T0 + 9000, 'answer', 'Found it in src/auth.')
    expect(log.view(T0 + 9000).agents[0]).toMatchObject({ status: 'done', endedAt: T0 + 9000 })
    log.toolFinished({ id: 'call-1', tool: 'Agent', input: brief, result: { status: 'completed', agentId: 'agent-1' }, nowMs: T0 + 9010 })

    const view = log.view(T0 + 9010)

    expect(view.agents[0]).toMatchObject({ status: 'done', endedAt: T0 + 9000, answer: 'Found it in src/auth.', steps: 1 })
    expect(view.tools).toEqual([{ name: 'Agent', count: 1 }])
    expect(view.log.map(entry => entry.kind)).toEqual(['spawn', 'done'])
  })

  test('a background agent keeps running after its Agent call returns, and past its turn', () => {
    const log = createSessionLog()

    log.turnStarted({ text: 'Look into the auth code', nowMs: T0, costUsd: 1 })
    log.toolStarted({ id: 'call-1', tool: 'Agent', input: brief, nowMs: T0 + 50 })
    spawn(log, 'agent-1', T0 + 100)
    log.toolFinished({
      id: 'call-1',
      tool: 'Agent',
      input: brief,
      result: { status: 'async_launched', agentId: 'agent-1' },
      nowMs: T0 + 150,
    })
    expect(log.view(T0 + 150).agents[0]).toMatchObject({ status: 'running', endedAt: null })

    // the main turn ends while the agent works on
    log.turnCompleted({ reason: 'answer', answer: 'Started it.', durationMs: 1000, costUsd: 1.5, nowMs: T0 + 1000 })
    expect(log.view(T0 + 1000).receipt).toEqual({
      isRunning: false,
      startedAt: T0,
      durationMs: 1000,
      agents: 1,
      edits: 0,
      errors: 0,
      costUsd: 0.5,
    })
    expect(log.view(T0 + 1000).agents[0]?.status).toBe('running')

    // its work after that reaches its card, and no receipt
    log.agentStepped({ agentId: 'agent-1', usage: { input_tokens: 200, output_tokens: 20 }, stopReason: 'tool_use', nowMs: T0 + 5000 })
    run(log, { id: 'e1', tool: 'Edit', agentId: 'agent-1', input: { file_path: '/repo/src/auth.ts' } }, T0 + 6000)
    expect(log.view(T0 + 6010).agents[0]).toMatchObject({ status: 'running', steps: 1, contextTokens: 200 })
    finishAgent(log, 'agent-1', T0 + 60_000, 'answer', 'Patched the auth code.')

    const view = log.view(T0 + 60_000)

    expect(view.agents[0]).toMatchObject({ status: 'done', endedAt: T0 + 60_000, answer: 'Patched the auth code.' })
    expect(view.receipt).toEqual({ isRunning: false, startedAt: T0, durationMs: 1000, agents: 1, edits: 0, errors: 0, costUsd: 0.5 })
    expect(view.log.at(-1)).toMatchObject({ kind: 'done', text: 'done · 1m00s', agentId: 'agent-1' })
  })
})

describe('turn receipt', () => {
  test('there is none before the first turn', () => {
    expect(createSessionLog().view(T0).receipt).toBeNull()
  })

  test('a turn in progress is running, with the time so far', () => {
    const log = createSessionLog()

    log.turnStarted({ text: 'fix the parser', nowMs: T0, costUsd: 1.5 })
    expect(log.view(T0 + 7000).receipt).toEqual({
      isRunning: true,
      startedAt: T0,
      durationMs: 7000,
      agents: 0,
      edits: 0,
      errors: 0,
      costUsd: null,
    })
    expect(log.view(T0 + 9000).receipt?.durationMs).toBe(9000)
  })

  test('counts the edits that worked, and the failures of the main loop', () => {
    const log = createSessionLog()

    log.turnStarted({ text: 'fix it', nowMs: T0, costUsd: null })
    run(log, { id: '1', tool: 'Edit', input: { file_path: '/repo/a.ts' } }, T0 + 10)
    run(log, { id: '2', tool: 'Write', input: { file_path: '/repo/b.ts' } }, T0 + 20)
    run(log, { id: '3', tool: 'NotebookEdit', input: { notebook_path: '/repo/c.ipynb' } }, T0 + 30)
    run(log, { id: '4', tool: 'Edit', input: { file_path: '/repo/a.ts' }, isError: true }, T0 + 40)
    run(log, { id: '5', tool: 'Edit', input: { file_path: '/repo/a.ts' }, isDenied: true }, T0 + 50)
    run(log, { id: '6', tool: 'Bash', input: { command: 'npm test' }, isError: true }, T0 + 60)
    run(log, { id: '7', tool: MCP, isError: true }, T0 + 70)
    run(log, { id: '8', tool: 'Read', input: { file_path: '/repo/a.ts' } }, T0 + 80)
    run(log, { id: '9', tool: 'Bash', input: { command: 'rm x' }, isDenied: true }, T0 + 90)
    // three edits that worked; a failed Edit, a failed Bash and a failed MCP call are the errors
    expect(log.view(T0 + 100).receipt).toMatchObject({ isRunning: true, edits: 3, errors: 3 })
  })

  test('edits made by a subagent count, its failures do not', () => {
    const log = createSessionLog()

    log.turnStarted({ text: 'delegate it', nowMs: T0, costUsd: null })
    spawn(log, 'agent-1', T0 + 1)
    run(log, { id: '1', tool: 'Edit', agentId: 'agent-1', input: { file_path: '/repo/a.ts' } }, T0 + 10)
    run(log, { id: '2', tool: 'Bash', agentId: 'agent-1', input: { command: 'npm test' }, isError: true }, T0 + 20)
    expect(log.view(T0 + 30).receipt).toMatchObject({ edits: 1, errors: 0 })
    // the failure is still on the agent's card and in the log
    expect(log.view(T0 + 30).agents[0]?.tools.at(-1)).toMatchObject({ tool: 'Bash', isError: true })
    expect(log.view(T0 + 30).log.at(-1)).toMatchObject({
      kind: 'error',
      who: 'Find the auth…',
      text: 'Bash npm test failed',
      agentId: 'agent-1',
    })
  })

  test('counts the agents spawned since the start, even past the 24 cards the tracker holds', () => {
    const log = createSessionLog()

    spawn(log, 'before', T0 - 1000)
    log.turnStarted({ text: 'fan out', nowMs: T0, costUsd: null })
    for (let index = 0; index < 30; index += 1) {
      spawn(log, `a${index}`, T0 + index)
    }
    expect(log.view(T0 + 100).receipt?.agents).toBe(30)
    log.turnCompleted({ reason: 'answer', answer: 'ok', durationMs: 100, nowMs: T0 + 100 })
    expect(log.view(T0 + 100).receipt?.agents).toBe(30)
  })

  test('the end closes it with the duration the event reports and the dollars the turn added', () => {
    const log = createSessionLog()

    log.turnStarted({ text: 'fix it', nowMs: T0, costUsd: 2.2259 })
    run(log, { id: '1', tool: 'Edit', input: { file_path: '/repo/a.ts' } }, T0 + 10)
    spawn(log, 'agent-1', T0 + 20)
    log.turnCompleted({ reason: 'answer', answer: 'Fixed.', durationMs: 12_345, costUsd: 3.4518, nowMs: T0 + 13_000 })
    expect(log.view(T0 + 20_000).receipt).toEqual({
      isRunning: false,
      startedAt: T0,
      durationMs: 12_345,
      agents: 1,
      edits: 1,
      errors: 0,
      costUsd: 1.2259,
    })
  })

  test('the cost is null when either end is unknown, and when it went down', () => {
    const cost = (atStart: number | null, atEnd: number | null) => {
      const log = createSessionLog()

      log.turnStarted({ text: 'go', nowMs: T0, costUsd: atStart })
      log.turnCompleted({ reason: 'answer', answer: '', durationMs: 1, costUsd: atEnd, nowMs: T0 + 1 })

      return log.view(T0 + 1).receipt?.costUsd
    }

    expect(cost(1, 1.25)).toBe(0.25)
    expect(cost(1, 1)).toBe(0)
    expect(cost(null, 1.25)).toBeNull()
    expect(cost(1, null)).toBeNull()
    expect(cost(2, 1)).toBeNull()
    expect(cost(Number.NaN, 1)).toBeNull()
  })

  test('an interrupted or failed turn closes the receipt too', () => {
    for (const reason of ['aborted', 'error', 'refusal']) {
      const log = createSessionLog()

      log.turnStarted({ text: 'go', nowMs: T0, costUsd: null })
      log.turnCompleted({ reason, answer: '', durationMs: 500, nowMs: T0 + 500 })
      expect(log.view(T0 + 500).receipt).toMatchObject({ isRunning: false, durationMs: 500 })
    }
  })

  test('calls after the turn ended do not touch the receipt', () => {
    const log = createSessionLog()

    log.turnStarted({ text: 'go', nowMs: T0, costUsd: null })
    log.turnCompleted({ reason: 'answer', answer: '', durationMs: 100, nowMs: T0 + 100 })
    run(log, { id: '1', tool: 'Edit', input: { file_path: '/repo/a.ts' } }, T0 + 200)
    run(log, { id: '2', tool: 'Bash', input: { command: 'make' }, isError: true }, T0 + 300)
    spawn(log, 'late', T0 + 400)
    expect(log.view(T0 + 500).receipt).toEqual({
      isRunning: false,
      startedAt: T0,
      durationMs: 100,
      agents: 0,
      edits: 0,
      errors: 0,
      costUsd: null,
    })
  })

  test('a new turn starts a fresh receipt', () => {
    const log = createSessionLog()

    log.turnStarted({ text: 'one', nowMs: T0, costUsd: 1 })
    run(log, { id: '1', tool: 'Edit', input: { file_path: '/repo/a.ts' } }, T0 + 10)
    log.turnCompleted({ reason: 'answer', answer: '', durationMs: 100, costUsd: 2, nowMs: T0 + 100 })
    log.turnStarted({ text: 'two', nowMs: T0 + 1000, costUsd: 2 })
    expect(log.view(T0 + 1500).receipt).toEqual({
      isRunning: true,
      startedAt: T0 + 1000,
      durationMs: 500,
      agents: 0,
      edits: 0,
      errors: 0,
      costUsd: null,
    })
  })

  test('a turn that ends with no start seen still leaves a receipt', () => {
    const log = createSessionLog()

    log.turnCompleted({ reason: 'answer', answer: 'ok', durationMs: 4000, costUsd: 3, nowMs: T0 + 4000 })
    expect(log.view(T0 + 4000).receipt).toEqual({
      isRunning: false,
      startedAt: T0,
      durationMs: 4000,
      agents: 0,
      edits: 0,
      errors: 0,
      costUsd: null,
    })
  })

  test('a second end with no start between does not carry the last turn over', () => {
    const log = createSessionLog()

    log.turnStarted({ text: 'go', nowMs: T0, costUsd: 1 })
    run(log, { id: '1', tool: 'Edit', input: { file_path: '/repo/a.ts' } }, T0 + 10)
    spawn(log, 'agent-1', T0 + 20)
    run(log, { id: '2', tool: 'Bash', input: { command: 'make' }, isError: true }, T0 + 30)
    log.turnCompleted({ reason: 'answer', answer: '', durationMs: 100, costUsd: 2, nowMs: T0 + 100 })
    log.turnCompleted({ reason: 'answer', answer: '', durationMs: 50, costUsd: 3, nowMs: T0 + 500 })
    expect(log.view(T0 + 500).receipt).toEqual({
      isRunning: false,
      startedAt: T0 + 450,
      durationMs: 50,
      agents: 0,
      edits: 0,
      errors: 0,
      costUsd: null,
    })
  })

  test('a refused call is no error, even when the call reports one', () => {
    const log = createSessionLog()

    log.turnStarted({ text: 'go', nowMs: T0, costUsd: null })
    log.toolStarted({ id: 'a', tool: MCP, nowMs: T0 + 1 })
    log.toolChecked({ id: 'a', tool: MCP, decision: 'deny', nowMs: T0 + 2 })
    log.toolFinished({ id: 'a', tool: MCP, isError: true, nowMs: T0 + 3 })
    log.toolChecked({ id: 'b', tool: 'Bash', input: { command: 'rm -rf build' }, decision: 'ask', nowMs: T0 + 4 })
    log.toolFinished({ id: 'b', tool: 'Bash', input: { command: 'rm -rf build' }, isError: true, isDenied: true, nowMs: T0 + 5 })

    const view = log.view(T0 + 10)

    expect(view.receipt).toMatchObject({ errors: 0 })
    expect(view.mcp[0]).toMatchObject({ errors: 0, lastMs: null, inFlight: [] })
    expect(view.log.map(entry => entry.kind)).toEqual(['prompt', 'denied', 'denied'])
  })

  test('a duration that is not a time falls back to the clock', () => {
    for (const durationMs of [Number.NaN, -1000, Number.POSITIVE_INFINITY]) {
      const log = createSessionLog()

      log.turnStarted({ text: 'go', nowMs: T0, costUsd: null })
      log.turnCompleted({ reason: 'answer', answer: '', durationMs, nowMs: T0 + 800 })
      expect(log.view(T0 + 800).receipt?.durationMs).toBe(800)
    }
  })
})

describe('log', () => {
  test('logs the first line of the prompt', () => {
    const log = createSessionLog()

    log.turnStarted({ text: '\n\n  Fix the parser so it handles empty lists.\nThen add a test.', nowMs: T0, costUsd: null })
    expect(log.view(T0).log).toEqual([
      { at: T0, kind: 'prompt', who: 'you', text: 'Fix the parser so it handles empty lists.', agentId: null },
    ])
  })

  test('masks and cuts the prompt line', () => {
    const log = createSessionLog()

    log.turnStarted({ text: `deploy with token=hunter2 ${'z'.repeat(400)}`, nowMs: T0, costUsd: null })

    const line = log.view(T0).log[0]?.text ?? ''

    expect(line.startsWith('deploy with token=••• zzz')).toBe(true)
    expect(line).toHaveLength(160)
    expect(line.endsWith('…')).toBe(true)
  })

  test('says so when the engine opened the turn with a tagged message', () => {
    const log = createSessionLog()

    log.turnStarted({ text: '<agent-message from="agent-1234567890">\nThe report follows:\nall good', nowMs: T0, costUsd: null })
    log.turnStarted({ text: '<task-notification>\n<task-id>7</task-id>', nowMs: T0 + 1, costUsd: null })
    log.turnStarted({ text: '<div>fix this markup</div>', nowMs: T0 + 2, costUsd: null })
    expect(log.view(T0 + 2).log.map(entry => [entry.who, entry.text])).toEqual([
      ['engine', 'agent message from agent-12'],
      ['engine', 'task notification'],
      ['you', '<div>fix this markup</div>'],
    ])
  })

  test('a turn with no text logs nothing', () => {
    const log = createSessionLog()

    log.turnStarted({ text: '', nowMs: T0, costUsd: null })
    log.turnStarted({ text: '  \n \t\n', nowMs: T0 + 1, costUsd: null })
    expect(log.view(T0 + 1).log).toEqual([])
    expect(log.view(T0 + 1).receipt?.isRunning).toBe(true)
  })

  test('logs edits, errors and denials, and not every call', () => {
    const log = createSessionLog()

    run(log, { id: '1', tool: 'Read', input: { file_path: '/repo/a.ts' } }, T0)
    run(log, { id: '2', tool: 'Bash', input: { command: 'ls' }, result: { stdout: 'a' } }, T0 + 100)
    run(log, { id: '3', tool: 'Grep', input: { pattern: 'x' } }, T0 + 200)
    expect(log.view(T0 + 300).log).toEqual([])

    run(log, { id: '4', tool: 'Edit', input: { file_path: '/repo/a.ts', old_string: 'a', new_string: 'b' } }, T0 + 300)
    run(log, { id: '5', tool: 'Write', agentId: 'agent-1', input: { file_path: '/repo/b.ts', content: 'x' } }, T0 + 400)
    run(log, { id: '6', tool: 'Bash', input: { command: 'npm test' }, isError: true }, T0 + 500)
    run(log, { id: '7', tool: 'Bash', input: { command: 'rm -rf build' }, isDenied: true }, T0 + 600)
    run(log, { id: '8', tool: 'Edit', input: { file_path: '/repo/c.ts' }, isError: true }, T0 + 700)

    expect(log.view(T0 + 800).log).toEqual([
      { at: T0 + 310, kind: 'edit', who: 'main', text: 'Edit /repo/a.ts', agentId: null },
      { at: T0 + 410, kind: 'edit', who: 'agent', text: 'Write /repo/b.ts', agentId: 'agent-1' },
      { at: T0 + 510, kind: 'error', who: 'main', text: 'Bash npm test failed', agentId: null },
      { at: T0 + 610, kind: 'denied', who: 'main', text: 'Bash rm -rf build', agentId: null },
      { at: T0 + 710, kind: 'error', who: 'main', text: 'Edit /repo/c.ts failed', agentId: null },
    ])
  })

  test('names an MCP tool by its server and tool', () => {
    const log = createSessionLog()

    run(log, { id: '1', tool: MCP, input: { query: 'how to mount a pane' }, isError: true }, T0)
    expect(log.view(T0 + 20).log[0]?.text).toBe('docs/search how to mount a pane failed')
  })

  test('names the subagent that did it', () => {
    const log = createSessionLog()

    spawn(log, 'agent-1', T0, { description: 'Review' })
    run(log, { id: '1', tool: 'Edit', agentId: 'agent-1', input: { file_path: '/repo/a.ts' } }, T0 + 100)
    expect(log.view(T0 + 200).log.at(-1)).toEqual({
      at: T0 + 110,
      kind: 'edit',
      who: 'Review',
      text: 'Edit /repo/a.ts',
      agentId: 'agent-1',
    })
  })

  test('masks secrets in what it writes', () => {
    const log = createSessionLog()

    run(log, { id: '1', tool: 'Bash', input: { command: `deploy --api-key=${fake('sk-', 30)}` }, isError: true }, T0)
    expect(log.view(T0 + 20).log[0]?.text).toBe('Bash deploy --api-key=••• failed')
  })

  test('keeps the newest 200 entries, newest last', () => {
    const log = createSessionLog()

    for (let index = 0; index < 250; index += 1) {
      log.turnStarted({ text: `prompt ${index}`, nowMs: T0 + index, costUsd: null })
    }

    const entries = log.view(T0 + 250).log

    expect(entries).toHaveLength(200)
    expect(entries[0]?.text).toBe('prompt 50')
    expect(entries[199]?.text).toBe('prompt 249')
  })

  test('counts compactions and logs each, but not a precompute', () => {
    const log = createSessionLog()

    log.compacted({ trigger: 'auto', nowMs: T0 })
    log.compacted({ trigger: 'precompute', nowMs: T0 + 1 })
    log.compacted({ trigger: 'manual', nowMs: T0 + 2 })

    const view = log.view(T0 + 2)

    expect(view.compactions).toBe(2)
    expect(view.log).toEqual([
      { at: T0, kind: 'compact', who: 'main', text: 'context compacted (auto)', agentId: null },
      { at: T0 + 2, kind: 'compact', who: 'main', text: 'context compacted (manual)', agentId: null },
    ])
  })
})

describe('git operations', () => {
  test('a commit, a push and a pull request become log lines, each from its structured result', () => {
    const log = createSessionLog()

    run(
      log,
      {
        id: '1',
        tool: 'Bash',
        input: { command: 'git commit -m "x" && git push && gh pr create' },
        result: git({
          commit: { sha: 'abc1234def5678', kind: 'committed', branch: 'feat/x' },
          push: { branch: 'feat/x' },
          pr: { number: 42, action: 'created', url: 'https://github.com/acme/widgets/pull/42' },
        }),
      },
      T0,
    )
    expect(log.view(T0 + 20).log).toEqual([
      { at: T0 + 10, kind: 'git', who: 'main', text: 'committed abc1234', agentId: null },
      { at: T0 + 10, kind: 'git', who: 'main', text: 'pushed feat/x', agentId: null },
      { at: T0 + 10, kind: 'git', who: 'main', text: 'PR #42 created', agentId: null },
    ])
  })

  test('says what kind of commit, and what a pull request did', () => {
    const log = createSessionLog()
    const texts = () => log.view(T0 + 1000).log.map(entry => entry.text)

    run(log, { id: '1', tool: 'Bash', result: git({ commit: { sha: 'aaaaaaa1111', kind: 'amended' } }) }, T0)
    run(log, { id: '2', tool: 'Bash', result: git({ commit: { sha: 'bbbbbbb2222', kind: 'cherry-picked' } }) }, T0 + 100)
    run(log, { id: '3', tool: 'Bash', result: git({ pr: { number: 7, action: 'auto-merge-enabled' } }) }, T0 + 200)
    run(log, { id: '4', tool: 'Bash', result: git({ pr: { number: 7, action: 'merged' } }) }, T0 + 300)
    run(log, { id: '5', tool: 'Bash', result: git({ pr: { number: 8 } }) }, T0 + 400)
    run(log, { id: '6', tool: 'Bash', result: git({ commit: { sha: 'ccccccc3333' } }) }, T0 + 500)
    expect(texts()).toEqual([
      'amended aaaaaaa',
      'cherry-picked bbbbbbb',
      'PR #7 auto merge enabled',
      'PR #7 merged',
      'PR #8',
      'committed ccccccc',
    ])
  })

  test('a merge or a rebase names the branch', () => {
    const log = createSessionLog()

    run(log, { id: '1', tool: 'Bash', result: git({ branch: { ref: 'feat/x', action: 'merged' } }) }, T0)
    run(log, { id: '2', tool: 'Bash', result: git({ branch: { ref: 'main', action: 'rebased' } }) }, T0 + 100)
    expect(log.view(T0 + 200).log.map(entry => entry.text)).toEqual(['merged feat/x', 'rebased onto main'])
  })

  test('puts a commit, a merge, a push and a pull request in that order', () => {
    const log = createSessionLog()

    run(
      log,
      {
        id: '1',
        tool: 'Bash',
        result: git({
          pr: { number: 1, action: 'created' },
          push: { branch: 'feat/x' },
          branch: { ref: 'main', action: 'rebased' },
          commit: { sha: 'abc1234', kind: 'committed' },
        }),
      },
      T0,
    )
    expect(log.view(T0 + 20).log.map(entry => entry.text)).toEqual([
      'committed abc1234',
      'rebased onto main',
      'pushed feat/x',
      'PR #1 created',
    ])
  })

  test('attributes a git operation made by a subagent to it', () => {
    const log = createSessionLog()

    spawn(log, 'agent-1', T0, { description: 'Release' })
    run(log, { id: '1', tool: 'Bash', agentId: 'agent-1', result: git({ push: { branch: 'release' } }) }, T0 + 100)
    expect(log.view(T0 + 200).log.at(-1)).toEqual({ at: T0 + 110, kind: 'git', who: 'Release', text: 'pushed release', agentId: 'agent-1' })
  })

  test('logs nothing for a command that did no git, a failed one, or another tool', () => {
    const log = createSessionLog()

    run(log, { id: '1', tool: 'Bash', input: { command: 'ls' }, result: { stdout: 'a', stderr: '', interrupted: false } }, T0)
    run(
      log,
      { id: '2', tool: 'Bash', input: { command: 'git push' }, isError: true, result: git({ push: { branch: 'feat/x' } }) },
      T0 + 100,
    )
    run(
      log,
      { id: '3', tool: 'Bash', input: { command: 'git push' }, isDenied: true, result: git({ push: { branch: 'feat/x' } }) },
      T0 + 200,
    )
    run(log, { id: '4', tool: 'Read', input: { file_path: '/repo/a.ts' }, result: git({ push: { branch: 'feat/x' } }) }, T0 + 300)
    run(log, { id: '5', tool: 'Bash', input: { command: 'git status' }, result: undefined }, T0 + 400)
    run(log, { id: '6', tool: 'Bash', input: { command: 'git status' }, result: 'plain text' }, T0 + 500)
    run(
      log,
      {
        id: '7',
        tool: 'Bash',
        input: { command: 'git status' },
        result: git({ push: {}, commit: { kind: 'committed' }, pr: { action: 'created' } }),
      },
      T0 + 600,
    )
    expect(log.view(T0 + 700).log.filter(entry => entry.kind === 'git')).toEqual([])
  })

  test('reads a PowerShell result the same way', () => {
    const log = createSessionLog()

    run(log, { id: '1', tool: 'PowerShell', result: git({ push: { branch: 'feat/x' } }) }, T0)
    expect(log.view(T0 + 20).log.map(entry => entry.text)).toEqual(['pushed feat/x'])
  })
})

describe('reset', () => {
  /** A session with something in every part of the view. */
  function busy(log: SessionLog): void {
    log.turnStarted({ text: 'do it', nowMs: T0, costUsd: 1 })
    log.toolStarted({ id: 'm1', tool: MCP, nowMs: T0 + 1 })
    log.toolChecked({ id: 'g1', tool: 'Bash', input: { command: 'ls' }, decision: 'ask', nowMs: T0 + 2 })
    spawn(log, 'agent-1', T0 + 3)
    log.compacted({ trigger: 'auto', nowMs: T0 + 4 })
  }

  test('forgets everything', () => {
    const log = createSessionLog()

    busy(log)
    expect(log.view(T0 + 10).mcp).toHaveLength(1)
    log.reset()
    expect(log.view(T0 + 10)).toEqual({ mcp: [], agents: [], gate: [], log: [], receipt: null, compactions: 0, tools: [] })
  })

  test('works again afterwards from nothing', () => {
    const log = createSessionLog()

    busy(log)
    log.reset()
    run(log, { id: 'm2', tool: MCP }, T0 + 100, 25)
    expect(log.view(T0 + 200).mcp[0]).toMatchObject({ calls: 1, totalMs: 25, inFlight: [] })
    expect(log.view(T0 + 200).tools).toEqual([{ name: MCP, count: 1 }])
  })

  test('a call that began before the reset leaves no trace when it ends', () => {
    const log = createSessionLog()

    busy(log)
    log.reset()
    log.toolFinished({ id: 'm1', tool: MCP, nowMs: T0 + 500 })
    log.toolFinished({ id: 'g1', tool: 'Bash', input: { command: 'ls' }, nowMs: T0 + 500 })
    log.agentStepped({ agentId: 'agent-1', usage: { input_tokens: 5, output_tokens: 1 }, nowMs: T0 + 500 })
    finishAgent(log, 'agent-1', T0 + 600)
    expect(log.view(T0 + 700)).toMatchObject({ mcp: [], agents: [], gate: [], receipt: null })
  })

  test('an agent that ended before the reset does not end a later agent of the same id', () => {
    const log = createSessionLog()

    finishAgent(log, 'agent-1', T0)
    log.reset()
    spawn(log, 'agent-1', T0 + 10)
    expect(log.view(T0 + 10).agents[0]?.status).toBe('running')
  })
})

describe('the view', () => {
  test('shares nothing with the tracker', () => {
    const log = createSessionLog()

    log.turnStarted({ text: 'go', nowMs: T0, costUsd: null })
    log.toolStarted({ id: 'm1', tool: MCP, nowMs: T0 + 1 })
    log.toolChecked({ id: 'g1', tool: 'Bash', input: { command: 'ls' }, decision: 'ask', nowMs: T0 + 2 })
    spawn(log, 'agent-1', T0 + 3)
    run(log, { id: 't1', tool: 'Read', agentId: 'agent-1', input: { file_path: '/repo/a.ts' } }, T0 + 4)
    run(log, { id: 'e1', tool: 'Edit', input: { file_path: '/repo/a.ts' } }, T0 + 5)

    const before: unknown = JSON.parse(JSON.stringify(log.view(T0 + 10)))
    const view = log.view(T0 + 10)

    view.mcp[0]?.inFlight.splice(0)
    if (view.mcp[0] !== undefined) {
      view.mcp[0].calls = 99
    }
    view.agents[0]?.tools.splice(0)
    if (view.agents[0] !== undefined) {
      view.agents[0].status = 'failed'
    }
    view.gate.splice(0)
    view.log.splice(0)
    view.tools.splice(0)
    if (view.receipt !== null) {
      view.receipt.edits = 99
    }
    expect(JSON.parse(JSON.stringify(log.view(T0 + 10)))).toEqual(before)
  })

  test('replays one whole session', () => {
    const log = createSessionLog()

    log.turnStarted({ text: 'Add a docs search to the widgets app', nowMs: T0, costUsd: 1 })

    // the main loop delegates the research to a subagent
    log.toolStarted({ id: 'call-1', tool: 'Agent', input: { description: 'Find the docs API' }, nowMs: T0 + 100 })
    log.toolChecked({ id: 'call-1', tool: 'Agent', input: { description: 'Find the docs API' }, decision: 'allow', nowMs: T0 + 101 })
    spawn(log, 'agent-1', T0 + 200, { description: 'Find the docs API' })
    log.agentStepped({
      agentId: 'agent-1',
      usage: { input_tokens: 500, cache_read_input_tokens: 1500, output_tokens: 80 },
      stopReason: 'tool_use',
      nowMs: T0 + 900,
    })
    log.toolStarted({ id: 'mcp-1', tool: MCP, agentId: 'agent-1', input: { query: 'search api' }, nowMs: T0 + 1000 })
    log.toolChecked({ id: 'mcp-1', tool: MCP, input: { query: 'search api' }, decision: 'ask', agentId: 'agent-1', nowMs: T0 + 1001 })
    log.toolFinished({ id: 'mcp-1', tool: MCP, agentId: 'agent-1', input: { query: 'search api' }, nowMs: T0 + 1400 })
    log.agentStepped({
      agentId: 'agent-1',
      usage: { input_tokens: 700, cache_read_input_tokens: 1500, output_tokens: 120 },
      stopReason: 'end_turn',
      nowMs: T0 + 2000,
    })
    log.turnCompleted({ agentId: 'agent-1', reason: 'answer', answer: 'The API is under /v2/search.', durationMs: 1800, nowMs: T0 + 2000 })
    log.toolFinished({
      id: 'call-1',
      tool: 'Agent',
      input: { description: 'Find the docs API' },
      result: { status: 'completed', agentId: 'agent-1' },
      nowMs: T0 + 2010,
    })

    // then it edits, tests and commits
    log.toolChecked({ id: 'edit-1', tool: 'Edit', input: { file_path: '/repo/src/search.ts' }, decision: 'allow', nowMs: T0 + 3000 })
    run(log, { id: 'edit-1', tool: 'Edit', input: { file_path: '/repo/src/search.ts' } }, T0 + 3000, 20)
    log.toolChecked({ id: 'test-1', tool: 'Bash', input: { command: 'npm test' }, decision: 'ask', nowMs: T0 + 4000 })
    run(log, { id: 'test-1', tool: 'Bash', input: { command: 'npm test' }, isError: true }, T0 + 4000, 3000)
    run(log, { id: 'test-2', tool: 'Bash', input: { command: 'npm test' } }, T0 + 8000, 3000)
    run(
      log,
      {
        id: 'commit-1',
        tool: 'Bash',
        input: { command: 'git commit -am search' },
        result: git({ commit: { sha: 'abcdef0123', kind: 'committed' } }),
      },
      T0 + 12_000,
    )
    log.compacted({ trigger: 'auto', nowMs: T0 + 13_000 })
    log.turnCompleted({ reason: 'answer', answer: 'Added the search.', durationMs: 14_000, costUsd: 1.75, nowMs: T0 + 14_000 })

    const view = log.view(T0 + 20_000)

    expect(view.mcp).toEqual([
      {
        server: 'docs',
        calls: 1,
        timedCalls: 1,
        errors: 0,
        subagentCalls: 1,
        totalMs: 400,
        maxMs: 400,
        lastMs: 400,
        lastTool: 'search',
        lastAt: T0 + 1400,
        inFlight: [],
      },
    ])
    expect(view.agents).toEqual([
      {
        id: 'agent-1',
        type: 'Explore',
        description: 'Find the docs API',
        model: 'claude-sonnet-5-5',
        status: 'done',
        startedAt: T0 + 200,
        endedAt: T0 + 2000,
        steps: 2,
        contextTokens: 2200,
        outputTokens: 200,
        tools: [{ tool: MCP, text: 'search api', isError: false }],
        answer: 'The API is under /v2/search.',
      },
    ])
    expect(view.gate.map(check => [check.id, check.family, check.verdict, check.inSubagent])).toEqual([
      ['call-1', 'other', 'rule', false],
      ['mcp-1', 'mcp', 'asked', true],
      ['edit-1', 'file', 'rule', false],
      ['test-1', 'shell', 'asked', false],
    ])
    expect(view.log.map(entry => [entry.kind, entry.who, entry.text])).toEqual([
      ['prompt', 'you', 'Add a docs search to the widgets app'],
      ['spawn', 'Find the docs…', 'spawned · Explore'],
      ['done', 'Find the docs…', 'done · 2s'],
      ['edit', 'main', 'Edit /repo/src/search.ts'],
      ['error', 'main', 'Bash npm test failed'],
      ['git', 'main', 'committed abcdef0'],
      ['compact', 'main', 'context compacted (auto)'],
    ])
    expect(view.receipt).toEqual({ isRunning: false, startedAt: T0, durationMs: 14_000, agents: 1, edits: 1, errors: 1, costUsd: 0.75 })
    expect(view.compactions).toBe(1)
    expect(view.tools).toEqual([
      { name: 'Bash', count: 3 },
      { name: 'Agent', count: 1 },
      { name: 'Edit', count: 1 },
      { name: MCP, count: 1 },
    ])
  })
})
