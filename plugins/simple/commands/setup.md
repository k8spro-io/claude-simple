---
name: setup
description: Install the `simple` setup into this project — the rule packs, the recommended settings and permissions for the stacks it uses, and the project's Obsidian memory vault. Merges, never clobbers.
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

3. **Ask which parts they want** if they did not already say. The four components are independent:
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

   The status line and the side panes (`/workbench`) are not components: they come with the plugin (a Claude Code
   mod), work with no setup, and are configured in `/config` — the rows `statusline`, `statuslineAbovePrompt`,
   `statuslineWeekly`, `statuslinePr`, `workbench` and `workbenchAutoOpen`. The installer still accepts `--statusline`
   so old instructions do not fail, but it only prints a note and changes nothing.

4. **Run it** with the flags they chose (or `--all` plus `--stack ...`), then report exactly what changed, from the
   script's own output. Do not claim anything the script did not print.

5. **Offer the old status line cleanup — only when it applies.** Versions up to 0.2.0 installed the status line as a
   script and set `statusLine` in the **user's** `~/.claude/settings.json`. A mod cannot remove that setting, so while
   it is there both status lines draw, and the plugin shows a one-time notice that points to this command. If that is
   why the user is here, this step is the whole job: do only this one. Look with a dry run, which only reads:

   ```bash
   bash "${CLAUDE_PLUGIN_ROOT}/scripts/install.sh" --remove-legacy-statusline --dry-run
   ```

   If it prints `settings.json statusLine: would remove`, the old setting is still there. Show the user that whole
   plan — every file and the setting it would remove, and what it keeps — and ask. Run it without `--dry-run` only on
   a yes. If the setting is `kept` and the script lines say `your statusLine still mentions statusline.py`, their
   `statusLine` runs a `statusline.py` but is not exactly the one older versions wrote: an edited copy of it, or a
   script of their own. Tell them both status lines draw while it is set, and that deleting the `statusLine` key from
   `~/.claude/settings.json` is their call; do not edit it for them. Otherwise (`absent`, or `kept` for any other
   status line) offer nothing. This is never part of `--all`: it edits the user's own files under `~/.claude`, not the
   project.

6. **Tell them the three follow-ups that are on them:**
   - The rule templates use generic `paths:` globs (`**/*.go`, `**/models/**/*.py`, …). If the repo has a different
     layout, edit those globs — a rule with a glob that never matches simply never loads, silently. Check one with
     `rg --files -g '<the glob>' | head`. Delete the packs for stacks they will never use if the file count bothers
     them.
   - The permission lists are a starting point. Anything in `deny` that the team genuinely needs should be removed
     deliberately rather than worked around one prompt at a time (`${CLAUDE_PLUGIN_ROOT}/docs/permissions.md`).
   - If `--memory` ran: `.claude/memory/.obsidian/` belongs in `.gitignore`, and whether the notes themselves are
     committed is a decision — committed they are the team's memory, ignored they are one person's.

7. **Offer the `AGENTS.md` skeleton** at `${CLAUDE_PLUGIN_ROOT}/templates/AGENTS.md` if the project has no instruction
   file yet. Do not write it without asking — that file is the project's voice, not the plugin's. If they want it,
   fill in the real values (directory names, ports, the actual gate command) by reading the repo; never leave the
   placeholders in place.

## Rules for this command

- Never overwrite a file the user already has. The installer is built to merge; keep it that way.
- If `.claude/settings.json` exists but is invalid JSON, say so and stop. Do not try to repair it.
- Never run `--remove-legacy-statusline` for real without showing its dry-run plan first and getting a yes.
- Report the real output. If a step was skipped, say which and why.
- Never guess a stack name: `--list-stacks` prints the valid ones, and an unknown one is reported and ignored.
