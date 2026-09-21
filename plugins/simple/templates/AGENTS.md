# <project>

<!--
  AGENTS.md skeleton from the `simple` plugin.

  This is the file Claude Code and other engines load on every session, so every line is paid for on
  every request. Keep it under ~100 lines. The test for a line is: "would a competent new colleague
  get this wrong without being told?" If not, delete it.

  Fill in the real values by reading the repo. NEVER ship it with the placeholders still in it —
  a wrong port or a wrong command is worse than no file at all.

  Claude Code reads AGENTS.md directly from v2.1.277. On older versions, in Bedrock, or with
  telemetry off, it may not — if you need the safety net, keep a CLAUDE.md on the root containing
  exactly one line: @AGENTS.md
-->

**<project>** — one sentence saying what this is and who uses it.

## Layout

```
<dir>     what lives here · language/framework · port
<dir>     ...
```

## Stack

- Language and framework, with the version that is actually pinned.
- Database, and where the connection string comes from.
- Package manager, build output, anything non-obvious about the toolchain.

## Invariants (non-negotiable)

Keep this list short and real. Each line is a rule someone has already broken, or would.

1. **Release gate:** `<the exact command>` must be green before any build or deploy. Output too big?
   Filter it **when reading** (`... 2>&1 | tail -60`), never by narrowing the command.
2. **Production data:** the live schema changes only by additive delta. NEVER `<the dangerous command>`.
3. **Language:** `<which language in code, which in docs>`. UI strings only through i18n.
4. **Leftovers become issues**, never TODO comments: `<the exact gh command>`.
5. Anything else that has actually bitten this team.

## Where the rest lives (do not duplicate here)

| I need | Go to |
|---|---|
| running the app, ports, deploy | skill `<name>` |
| reading a spec or decision record | skill `<name>` |
| a new decision record | skill `adr` |
| finding code without burning context | skill `code-navigation` |

Rules in `.claude/rules/` load themselves when a tool touches a matching path — they are not listed here.

## Orchestration

- **Delegating is the default.** The main session orchestrates: understand the request, map `file:line`, decide,
  dispatch. Execution goes to a subagent, a task or a Workflow — a Workflow when there is real parallelism (disjoint
  lanes), a subagent for everything else.
- **Model by layer.** Map / read / review → **haiku** worker. Implement → **sonnet** worker. The big model only
  orchestrates. A lean worker (`omitClaudeMd: true`) is still the right shape for one: it cuts the fixed context per
  request from 18.1k tokens to 4.8k. See skill `cost-per-fix` for what this costs and what it buys.
- **Two exceptions, and only these two.** The release gate runs in the orchestrating session — the invariant above
  requires output that was actually seen, and a worker's report is not seen output. Harness config (`settings.json`,
  hooks, the plugin itself) also stays in the orchestrating session, because a subagent refuses to edit it.
- **At most 4-6 subagents in parallel.** Past that the provider starts returning 429 and the work is lost.
- **A subagent's answer is capped at ~3,000 characters:** verdict, the findings that change a decision, and the
  path to the long report.
- **Never delegate understanding.** Map `file:line` yourself, then dispatch with the role, the constraints and
  the files. Authoring and review are separate passes — never self-approve.
- **A third-party plugin or harness enters only with a measurement** of a whole session, n ≥ 2 (skill `cost-per-fix`).

## Verification

NEVER claim a test, build or deploy passed without having run the command and seen the output; if you did not run
it, say so. A number written in a document must be true on disk today — count before writing it. Continuity lives
in the repo: commits, PRs, issues, decision records. An old workflow ID proves nothing.
