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

- **A subagent is not the default.** A bug contained in one package is a plain session. Measured on a real
  benchmark: orchestrating the same work cost 92% more for the same result. Reach for orchestration only when
  lanes are genuinely disjoint. See skill `cost-per-fix`.
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
