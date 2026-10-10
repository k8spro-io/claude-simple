// The shapes every part of the mod agrees on: what the lanes read from git
// and GitHub, what the session tracker notes from events, and what the views
// draw. Types only; nothing here runs.

// ---------------------------------------------------------------- GitHub

export type ReviewState = 'approved' | 'changes_requested' | 'pending' | 'draft'

/** One check of a pull request or one CI run's outcome. */
export type CheckOutcome = 'passed' | 'failed' | 'pending' | 'skipped'

export type Check = { name: string; outcome: CheckOutcome }

export type MergeState = 'clean' | 'behind' | 'dirty' | 'blocked' | 'unstable' | 'draft' | 'unknown'

export type IssueRef = {
  number: number
  title: string
  /** 'open' or 'closed'; '' while the title has not been fetched. */
  state: string
  url: string
  labels: string[]
  assignees: string[]
  /** Where the link came from: the branch name, a commit subject, or the PR's closing keywords. */
  source: 'branch' | 'commit' | 'pr'
}

export type PullRequest = {
  number: number
  title: string
  url: string
  author: string
  branch: string
  isDraft: boolean
  review: ReviewState | null
  /** People and teams asked to review who have not answered yet. */
  reviewers: string[]
  /** The latest review of each reviewer: who, and what they said. */
  reviews: { author: string; state: 'approved' | 'changes_requested' | 'commented' | 'dismissed' | 'pending' }[]
  checks: Check[]
  merge: MergeState
  /** The branch it merges into, when known: what "behind" is measured against. */
  base?: string
  isAutoMerge: boolean
  /** Issue numbers the PR closes on merge. */
  closes: number[]
  updatedAt: string
}

export type Issue = {
  number: number
  title: string
  url: string
  assignees: string[]
  labels: string[]
  updatedAt: string
  /** The open pull request that closes this issue, when GitHub knows one; null when none does, absent when not asked. */
  inPr?: number | null
}

/** The latest GitHub Actions run of a branch. */
export type CiRun = {
  workflow: string
  /** 'queued' | 'in_progress' map to pending; a completed run maps its conclusion. */
  outcome: CheckOutcome
  isRunning: boolean
  /** When it started (running) or finished (done), as epoch ms. */
  at: number
  url: string
  /** The commit it ran on, short. */
  sha: string
}

/** The Work tab: the GitHub side of what is in flight, as the github lane last read it. */
export type Work = {
  /** owner/name of the repository, from gh; null when the remote is not on GitHub. */
  repo: string | null
  branch: string | null
  /** The issues this branch is on: from its name, its commits and its PR. */
  tickets: IssueRef[]
  /** The branch's open pull request. */
  pr: PullRequest | null
  /** The branch's latest CI run. */
  ci: CiRun | null
  /** The repository's newest open pull requests: who is on what. null until read (the lists are read while the pane is on screen). */
  board: PullRequest[] | null
  /** Open issues assigned to the person across the owner's repositories, each with the PR closing it; null until read. */
  unstarted: Issue[] | null
  /** Open pull requests asking the person for a review, across the owner's repositories; null until read. */
  reviewQueue: PullRequest[] | null
  /** GitHub's own counts behind those lists, which show only their newest few; null until read. */
  totals: { board: number; reviewQueue: number; assigned: number } | null
  /** When the lane last read GitHub, epoch ms; 0 before the first read. */
  fetchedAt: number
  /** Why GitHub is not shown, when it is not: gh missing, not logged in, not a GitHub remote. */
  problem: string | null
  /** Whether the refresh button can clear the problem (a login, a network failure), as opposed to a setting or the repository. */
  canRetry: boolean
}

// ---------------------------------------------------------------- session

export type McpServer = {
  server: string
  calls: number
  errors: number
  /** Calls made inside subagents. */
  subagentCalls: number
  totalMs: number
  /** Calls timed to their end (the average's divisor): refused and running calls are not. */
  timedCalls?: number
  maxMs: number
  lastMs: number | null
  lastTool: string
  /** When the last call ended, epoch ms. */
  lastAt: number | null
  /** Calls running now, by tool_use_id: the tool and when it started. */
  inFlight: { id: string; tool: string; startedAt: number }[]
}

export type AgentStatus = 'running' | 'done' | 'stopped' | 'failed'

export type AgentCard = {
  id: string
  type: string
  description: string
  model: string
  status: AgentStatus
  startedAt: number
  endedAt: number | null
  steps: number
  /** Input tokens of its latest request: its context now. */
  contextTokens: number
  outputTokens: number
  /** Its last few tool calls, newest last. */
  tools: { tool: string; text: string; isError: boolean }[]
  /** The start of its final answer, once done. */
  answer: string
}

/** rule: allowed without asking; asked: put to the person or the auto-mode classifier, then run; pending: still waiting; denied: refused. */
export type GateVerdict = 'rule' | 'asked' | 'pending' | 'denied'

/** One permission check of a tool call, as `tool.check` and the call's settling saw it. */
export type GateCheck = {
  id: string
  tool: string
  /** file, shell, web, mcp or other: the drill-down it belongs to. */
  family: 'file' | 'shell' | 'web' | 'mcp' | 'other'
  verdict: GateVerdict
  inSubagent: boolean
  /** What the call was about, shortened, with anything that looks like a secret masked. */
  detail: string
  at: number
}

export type LogKind = 'prompt' | 'spawn' | 'done' | 'edit' | 'error' | 'denied' | 'compact' | 'git'

export type LogEntry = { at: number; kind: LogKind; who: string; text: string; agentId: string | null }

/** The last main-loop turn, or the one running. */
export type Receipt = {
  isRunning: boolean
  startedAt: number
  durationMs: number | null
  agents: number
  edits: number
  errors: number
  /** Dollars the turn added, when the session's cost is known at both ends. */
  costUsd: number | null
}

/** The Session tab: what this session did, from events alone. */
export type SessionView = {
  mcp: McpServer[]
  agents: AgentCard[]
  gate: GateCheck[]
  log: LogEntry[]
  receipt: Receipt | null
  compactions: number
  tools: { name: string; count: number }[]
}
