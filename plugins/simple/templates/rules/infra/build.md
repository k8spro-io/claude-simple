---
paths:
  - "**/Taskfile.yml"
  - "**/Makefile"
  - "**/justfile"
  - "**/package.json"
  - "**/pom.xml"
  - "**/build.gradle*"
  - "**/pyproject.toml"
---
# The build and task interface

Whatever the tool — Task, Make, just, npm scripts, Gradle, Maven, mix, cargo aliases — the same rules hold. This is the repository's public interface for humans, for CI and for an agent.

## One place, one name
- Every reusable command is born as a target **with a description**. A command that only lives in someone's shell history is not a command, and the next person reinvents it slightly differently.
- Long logic lives in `scripts/<area>/` and is **invoked by** a target. A loose script with no target calling it drifts until it no longer runs.
- Cite a target by **name**, never by line number — line numbers go stale on the first edit.
- The same names across repositories (`test`, `lint`, `build`, `dev`, `gate`) are worth more than locally clever ones. An agent and a new colleague both guess `task test` first.

## Do not invent a second way to run things
If the repo has a documented way to bring the stack up, use it. An ad-hoc `docker run` next to a defined target produces an environment nobody else can reproduce, and a bug found in it is not real.

## No gate starts its own environment
A test target that silently boots a database hides the fact that it needed one, and hangs in CI when it cannot. Targets that need an environment **check for it and fail with a clear message** naming the target that brings it up.

## Naming the gate honestly
- What runs in CI must be runnable locally under the same name. If CI runs more, the local target is lying.
- A deliberately disabled target `exit 1`s with the reason in the message — deleting it means someone helpfully adds it back next quarter.
- NEVER report "green" without the real output of the command.

## Tool-specific gotchas
- **Task:** `dir:` must be set at the **task** level; a per-command `dir:` is silently ignored in several versions and the command runs in the wrong directory.
- **Make:** recipes are tab-indented, each line is its own shell, and a target that shares a name with a file needs `.PHONY`.
- **npm scripts:** a script that only works with one package manager should say so; `npm` and `bun` resolve lifecycle scripts differently.
- **Gradle/Maven:** pin the wrapper and commit it. "Works on my machine" is usually a different JDK.
- Pin the toolchain per target (`GOTOOLCHAIN`, the Node/Python version) rather than trusting whatever is on PATH.
