---
name: setup
description: Install the `simple` setup into this project — recommended settings.json (permissions, env, auto-compact), the .claude/rules templates for Go / Nuxt-TypeScript / TiDB / Taskfile / CI, and the statusline. Merges, never clobbers.
---

Install the `simple` setup into the current project.

## What you are going to do

1. **Show what will change first.** Run the installer in dry-run mode and report the plan to the user:

   ```bash
   bash "${CLAUDE_PLUGIN_ROOT}/scripts/install.sh" --dry-run
   ```

2. **Ask which parts they want** if they did not already say. The four components are independent:
   - `--settings` — merges the recommended `permissions` (deny destructive commands, deny reads of build output and
     secrets, allow the read-only shell), `env`, `autoCompactWindow` and the official plugin marketplace into
     `.claude/settings.json`. Existing keys are never overwritten; only missing ones are added.
   - `--rules` — copies the rule templates into `.claude/rules/`. Files that already exist are kept.
   - `--lsp` — enables `gopls-lsp` and `typescript-lsp` for the project (this implies `--settings`) and installs the
     language servers they drive if they are missing: `gopls` via `go install`, and `tsserver` via
     `bun add -g typescript@6`. Pass `--no-binaries` to only write the settings. **TypeScript must be 6.x** — the 7.x
     native port ships no `tsserver` and the LSP fails with "Could not find a valid TypeScript installation".
   - `--statusline` — copies `statusline.py` and `statusline-weekly.py` to `~/.claude/` and enables them in the
     **user** settings. An existing `statusLine` is left alone and printed for them to switch by hand.

3. **Run it** with the flags they chose (or `--all`), then report exactly what changed, from the script's own output.
   Do not claim anything the script did not print.

4. **Tell them the two follow-ups that are on them:**
   - The rule templates use generic `paths:` globs (`**/*.go`, `app/**/*.vue`, …). If the repo has a different layout,
     edit those globs — a rule with a glob that never matches simply never loads, silently.
   - The permission lists are a starting point. Anything in `deny` that the team genuinely needs should be removed
     deliberately rather than worked around one prompt at a time.

5. **Offer the `AGENTS.md` skeleton** at `${CLAUDE_PLUGIN_ROOT}/templates/AGENTS.md` if the project has no instruction
   file yet. Do not write it without asking — that file is the project's voice, not the plugin's. If they want it,
   fill in the real values (directory names, ports, the actual gate command) by reading the repo; never leave the
   placeholders in place.

## Rules for this command

- Never overwrite a file the user already has. The installer is built to merge; keep it that way.
- If `.claude/settings.json` exists but is invalid JSON, say so and stop. Do not try to repair it.
- Report the real output. If a step was skipped, say which and why.
