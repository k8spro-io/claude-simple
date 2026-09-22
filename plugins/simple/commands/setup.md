---
name: setup
description: Install the `simple` setup into this project — the rule packs, the recommended settings and permissions for the stacks it uses, the statusline, and the project's Obsidian memory vault. Merges, never clobbers.
---

Install the `simple` setup into the current project.

## What you are going to do

1. **Show what will change first.** Run the installer in dry-run mode and report the plan to the user:

   ```bash
   bash "${CLAUDE_PLUGIN_ROOT}/scripts/install.sh" --dry-run
   ```

2. **Work out which stacks this repository uses** — you, not a script. One sweep is enough:

   ```bash
   ls; cat package.json go.mod pyproject.toml pom.xml Cargo.toml composer.json Gemfile mix.exs 2>/dev/null | head -60
   ```

   That list only decides **which command allowances go into `permissions.allow`**. The names to pass are the ones
   `--list-stacks` prints (`go`, `node`, `python`, `java`, `kotlin`, `rust`, `php`, `ruby`, `dotnet`, `elixir`,
   `scala`, `cpp`, `dart`, `swift`, `zig`, `clojure`, `shell`, `taskrunner`, `infra`). Show the user the list you
   chose before running it.

   **The rule packs are not selected** — all of them are installed. A rule file costs nothing until a tool touches a
   path its `paths:` glob matches, so the Java pack in a Python repo simply never loads. If the user objects to the
   file count, that is a taste question, not a cost one; `--rules` can be left out entirely.

3. **Ask which parts they want** if they did not already say. The five components are independent:
   - `--settings` — merges the recommended `permissions`, `env`, `autoCompactWindow` and the official plugin
     marketplace into `.claude/settings.json`. The base list is language-agnostic; `--stack a,b` adds those
     ecosystems' build, test and lint commands to `allow`. Existing keys are never overwritten.
   - `--rules` — copies every rule pack into `.claude/rules/`, flat, as `<category>-<name>.md`. Files that already
     exist are kept, under either the flat name or the short one.
   - `--memory` — creates the project's memory vault at `.claude/memory/` with a seeded `MEMORY.md`, and points
     Claude Code's auto-memory folder for this project at it with a symlink, moving any notes it already holds. See
     skill `project-memory` for the note format.
   - `--lsp` — enables the language-server plugins for the stacks you named (this implies `--settings`) and installs
     the servers they drive if missing: `gopls` via `go install`, `tsserver` via `bun add -g typescript@6`. Pass
     `--no-binaries` to only write the settings. **TypeScript must be 6.x** — the 7.x native port ships no
     `tsserver` and the LSP fails. Claude Code ships language servers for Go and TypeScript only.
   - `--statusline` — copies `statusline.py` and `statusline-weekly.py` to `~/.claude/` and enables them in the
     **user** settings. An existing `statusLine` is left alone and printed for them to switch by hand.

4. **Run it** with the flags they chose (or `--all` plus `--stack ...`), then report exactly what changed, from the
   script's own output. Do not claim anything the script did not print.

5. **Tell them the three follow-ups that are on them:**
   - The rule templates use generic `paths:` globs (`**/*.go`, `**/models/**/*.py`, …). If the repo has a different
     layout, edit those globs — a rule with a glob that never matches simply never loads, silently. Check one with
     `rg --files -g '<the glob>' | head`. Delete the packs for stacks they will never use if the file count bothers
     them.
   - The permission lists are a starting point. Anything in `deny` that the team genuinely needs should be removed
     deliberately rather than worked around one prompt at a time (`docs/permissions.md`).
   - If `--memory` ran: `.claude/memory/.obsidian/` belongs in `.gitignore`, and whether the notes themselves are
     committed is a decision — committed they are the team's memory, ignored they are one person's.

6. **Offer the `AGENTS.md` skeleton** at `${CLAUDE_PLUGIN_ROOT}/templates/AGENTS.md` if the project has no instruction
   file yet. Do not write it without asking — that file is the project's voice, not the plugin's. If they want it,
   fill in the real values (directory names, ports, the actual gate command) by reading the repo; never leave the
   placeholders in place.

## Rules for this command

- Never overwrite a file the user already has. The installer is built to merge; keep it that way.
- If `.claude/settings.json` exists but is invalid JSON, say so and stop. Do not try to repair it.
- Report the real output. If a step was skipped, say which and why.
- Never guess a stack name: `--list-stacks` prints the valid ones, and an unknown one is reported and ignored.
