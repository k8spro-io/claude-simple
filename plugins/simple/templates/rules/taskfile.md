---
paths:
  - "Taskfile.yml"
  - "**/Taskfile.yml"
  - "Makefile"
---
# Taskfile / Makefile — the single source of dev and gate

## One place, one name
- Every reusable command is born as a target **with a `desc:`** here. A script that only lives in someone's shell
  history is not a command, and the next person reinvents it slightly differently.
- Long logic goes into `scripts/<area>/` and is **invoked by** a target — never a loose script with no target calling
  it, because that script will drift until it no longer runs.
- Cite a target by **name**, never by line number: line numbers go stale on the first edit.

## Don't invent a second way to run things
If the repo has a documented way to bring the stack up, use it. Ad-hoc `docker run` next to a defined target produces
an environment nobody else can reproduce, and the bug you find in it is not real.

## No gate starts its own environment
A test target that silently boots a database hides the fact that it needed one, and hangs in CI when it cannot. Targets
that need an environment **check for it and fail with a clear message** telling you which target brings it up.

## Naming the gate honestly
- Whatever runs in the release gate must be runnable locally under the same name. If CI runs more than the local
  target, the local target is lying.
- A target that is deliberately disabled (because it is dangerous) should `exit 1` with the reason in the message —
  not be deleted, or someone will helpfully add it back.
- NEVER say "green" without the real output of the command.

## Task-specific gotchas
- `dir:` must be set at the **task** level. Per-command `dir:` is ignored silently in several versions — the command
  runs in the wrong directory and the error makes no sense.
- Pin the toolchain per target (`GOTOOLCHAIN`, node/bun version) rather than trusting whatever is on PATH. "Works on my
  machine" is usually a different compiler.
