# claude-simple

A Claude Code plugin marketplace with one plugin, **`simple`**: a lean setup for **any stack** — Go, Java/Kotlin,
Python, TypeScript, Rust, PHP, Ruby, C#, Elixir, Scala, C/C++, Dart, Swift, Zig, Clojure; React, Vue, Angular,
Svelte, React Native; sixteen ORMs; Postgres, MySQL/TiDB, MongoDB, Redis; Docker, Kubernetes, Terraform and CI.

Everything in it that makes a cost claim was measured with a hidden-oracle benchmark — including the parts that were
**rejected** after measuring. The findings, the protocol to reproduce them, and an explicit list of what is *not*
measured are in [`plugins/simple/docs/measurements.md`](plugins/simple/docs/measurements.md).

The short version:

> Fixing real bugs in a plain session and in an orchestrated one produced the **same result**, and the orchestrated
> run cost **92% more** and took **83% longer**. Four third-party "context savers" were measured the same way; all
> four came out neutral or worse.

So this plugin does not add an orchestration layer. It makes the plain session cheaper and harder to get wrong.

## Install

```
/plugin marketplace add k8spro-io/claude-simple
/plugin install simple@claude-simple
```

Then, inside the project you want to set up:

```
/simple:setup
```

It shows a dry run first, then installs: every rule pack, the recommended settings, the command allowances for the
stacks you name, and the project's memory vault. The status line and the side panes need no setup — they ship inside
the plugin.

## The design, in one idea

Two kinds of cost exist in a Claude Code session. Things in the **prefix of every request** (the instruction file,
tool definitions, agent and skill listings) are paid on every turn. Things that **load on demand** cost nothing until
they are relevant.

So this plugin puts almost nothing in the first category and everything in the second:

- **Five agents**, by role, not by language. The language knowledge does not live in them.
- **49 rule packs**, each with a `paths:` glob, that load themselves when a tool touches a matching file. That is
  where Go, Hibernate, Django, Prisma, TiDB, Kubernetes and the rest live — at zero cost until you open one.

Adding your sixteenth ORM to this plugin costs a file, not a token.

**That is also why there is no stack detector.** A pack that does not match your repository never loads, so all of
them are installed and the irrelevant ones sleep. The one thing that *is* chosen deliberately is which commands get
pre-approved — `--stack go,node` — because widening what may run without asking should never be guessed by a
heuristic.

## What you get

**Immediately, from the plugin itself:**

| | |
|---|---|
| `/simple:setup` | installs the project-level pieces a plugin cannot ship by itself: rules, settings, memory vault |
| status line | two rows under the prompt: where you are, and what the session costs — [below](#the-status-line-and-the-side-panes) |
| `/workbench` | two side panes: Work (ticket, pull request, CI, review requests) and Session (MCP calls, agents, permission checks, a log) |
| skill `code-navigation` | grep-first navigation with the map command for every language, and when the LSP is actually cheaper |
| skill `context-economy` | what keeps the prompt cache warm, what silently destroys it, and when delegating is cheaper than not |
| skill `cost-per-fix` | how to measure a tool before adopting it — and the trap that invalidates most benchmarks |
| skill `delivery-gate` | what must be true before saying "done", "green" or "deployed" |
| skill `adr` | decision records: numbering, the template, and amending without rewriting |
| skill `project-memory` | durable facts as an Obsidian vault in the repo: one note per fact, an index, `[[links]]` |
| agent `wf-reader` (haiku) | read-only worker: maps code in any language, answers with `file:line` |
| agent `wf-implementer` (sonnet) | back-end worker: applies the change, proves it with a test that was seen red, runs that language's gate |
| agent `front-implementer` (sonnet) | front-end worker for React/Vue/Angular/Svelte/RN: i18n, semantic tokens, typecheck as proof |
| agent `diff-reviewer` (opus) | adversarial review, deliberately without `Edit`/`Write`/`Bash` |
| agent `data-specialist` (opus) | schema, migration, ORM and query specialist that refuses destructive operations on live data |
| hook `read-budget` | blocks a whole-file read of a huge file and hands back the cheap recipe for that language |
| hook `format-on-edit` | runs the right formatter for what was just edited, if the machine has it |

Why those models, and how to change them: [`docs/model-policy.md`](plugins/simple/docs/model-policy.md).

**From `/simple:setup`, into your project:**

- `.claude/settings.json` — permissions (irreversible commands denied, build output and credentials unreadable, the
  read-only shell pre-approved), plus one fragment per stack you name adding that ecosystem's build/test/lint
  commands. Every entry is justified in [`docs/permissions.md`](plugins/simple/docs/permissions.md), including what
  these lists **cannot** protect you from: `deny` beats `allow` with no override, a `Read()` deny also blocks
  `Edit`/`Write` on that path, and a `Read()` deny does not stop `cat`. They are speed bumps against accidents, not a
  sandbox.
- `.claude/rules/` — every pack, flat, as `lang-go.md`, `orm-prisma.md`, `db-postgres.md`, `front-react.md`,
  `infra-ci.md`… (Claude Code only reads rule files that sit directly in that folder — a subdirectory is never
  loaded.) The full catalogue is in [`docs/rules-catalog.md`](plugins/simple/docs/rules-catalog.md).
- `.claude/memory/` — the project's memory as an **Obsidian vault**: one note per fact, `MEMORY.md` as the index,
  `[[links]]` between notes, and `templates/` with a note template per memory type (`project`, `feedback`, `user`,
  `reference`) plus a filled example — ready for Obsidian's Templates plugin, `{{title}}` and `{{date}}` included.
  Claude Code's own auto-memory folder for the project is symlinked to it, so what gets saved lands in the
  repository instead of a per-machine cache. Format and discipline: skill `project-memory`.
- **LSP enabled** for the stacks that have one: `gopls-lsp` and `typescript-lsp` from the official marketplace, plus
  the language servers they drive (`gopls`, and `tsserver` from TypeScript **6.x** — 7.x ships no tsserver and the
  LSP fails).
- `templates/AGENTS.md` — a skeleton for the instruction file, offered, never written without asking.

Everything merges. A file you already have is kept, and re-running converges instead of duplicating.

## The status line and the side panes

Both are drawn by the plugin itself, as a Claude Code **mod**. Nothing to install: no script copied into `~/.claude`,
no `statusLine` written into your settings.

**The status line** is two rows under the prompt, below Claude Code's own hint line:

- **Row 1, where you are:** the repository's name and the sub-path you are in, the worktree inside a linked worktree,
  the branch with `↑ahead ↓behind`, the lines added and removed against the branch's base (its merge-base with
  `origin/HEAD`, else `origin/main`, `origin/master`, `main`, `master`; uncommitted changes included), the number of
  changed tracked files, the pull request with its review mark, the branch's CI (`✓` and how long ago, `●` and a
  running clock, `✗` and the failing check), and the `--agent` name.
- **Row 2, what the session costs:** the model and an effort gauge (`▮▮▮▯▯ high`); a context gauge against the
  compaction window (`ctx ▰▰▰▱▱▱▱▱▱▱ 32% 95k/300k`; the window is `autoCompactWindow`,
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW` or the model's own, as Claude Code resolves it), then `⟲ compact`, which asks for
  a second click before it runs `/compact`; the prompt-cache hit ratio over the session's main-loop requests; the
  session cost; the 5-hour and 7-day plan gauges with the 7-day reset countdown; and the last seven days of tokens per
  model family.

It draws only in the terminal and the desktop app's Code tab, not in the VS Code extension, in `claude -p` / SDK runs
or in cloud sessions.

**The side panes**, Work and Session, open with `/workbench`:

- **Work**, from GitHub: the branch's ticket (from a branch name like `feat/123-x`, `#123` in the branch's commit
  subjects, and the pull request's closing keywords); its pull request — review state, reviewers still waiting, latest
  reviews, merge state against its base, auto-merge, and its checks, the failing and pending ones named; its CI; the
  repository's open pull requests with the issue each one closes; the issues assigned to you across the owner's
  repositories, each with its pull request or "no PR yet"; and the pull requests waiting on your review across the
  owner's repositories. Counts are GitHub's totals; a list shows "loading…" until it is first read.
- **Session**, what this session did: the current or last turn's receipt (time, agents, edits, errors, cost); the MCP
  servers — calls, errors, average and longest call (the tool's own time, without the permission prompt), and the calls
  in flight with a running clock; the agents as cards (type, description, steps, context and output tokens, elapsed),
  each opened by its digit; the permission checks as a strip of colored cells (allowed by a rule, asked, pending,
  denied) with the latest asked and denied ones; a log of prompts, agents started and finished, edits, errors, denials,
  compactions, commits, pushes and pull request actions; and tool counts. It starts over on `/clear` and `/resume`.

`/workbench [work|session] [open|close|refresh]`: bare, it opens both, or closes them when you can see them;
`refresh` reads GitHub again and opens nothing. From the command they open at any width. By themselves they open only
with `workbenchAutoOpen` on: once per session, in a fullscreen terminal at least 144 columns wide (110 once you have
opened them yourself). A pane you close by hand stays closed until you run `/workbench`.

Options — one row each in `/config`, or under `pluginConfigs["simple@claude-simple"].options` in your user settings:

| option | default | effect |
|---|---|---|
| `statusline` | on | draw the status line at all |
| `statuslineAbovePrompt` | off | draw its two rows in the band above the prompt instead |
| `statuslineWeekly` | on | the 7-day per-model totals (runs `python3`) |
| `statuslinePr` | on | the pull request and CI segments (ask GitHub) |
| `workbench` | on | the side panes and `/workbench` |
| `workbenchAutoOpen` | off | open the side panes by themselves, as above |

`STATUSLINE_NERD=1` in the environment adds a Nerd Font branch glyph.

What runs: `git` a few times per refresh, a `python3` script for the weekly totals, and — for the pull request, the
CI and the Work pane — one read-only `gh api graphql` call per refresh, only while one of them is on screen: every two
minutes, every minute while checks run, less often once the session is idle. Nothing goes to GitHub when the remote
is not on github.com, `gh` is missing or not logged in, or `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set. Every
process, when it runs, and what is read and written: [`docs/permissions.md`](plugins/simple/docs/permissions.md).

**Coming from 0.2 or earlier?** Those versions installed the status line as a script and pointed your **user** settings
at it. A mod cannot remove a settings status line, so until that one goes you get both; the mod shows a one-time
notice when it finds it. `/simple:setup` offers the cleanup, after showing what it would remove. By hand, from the
plugin's `scripts/` folder:

```bash
bash install.sh --remove-legacy-statusline --dry-run    # the plan: what goes, what is kept
bash install.sh --remove-legacy-statusline
```

It removes only what those versions wrote: the `statusLine` setting if it is exactly theirs, `statusline.py` and
`statusline-weekly.py` if they are byte-identical to the shipped copies, and the cache files the weekly script left.
Anything you changed is kept, and every item is reported.

## What it costs you

```
Always-on:   ~1.0k tok   added to every session
```

That is the price of five agents and six skills being *listed*. A skill or agent only costs its full text when it
actually fires. The rule packs cost **nothing** until a tool touches a matching path, however many you install. The
hooks cost nothing in context — they run in the harness.

Verify it yourself after installing, with `claude plugin details simple`.

## Requirements

- Claude Code **2.1.290 or later**, tested on 2.1.296. The status line and the side panes are a mod, and mods are a
  newer Claude Code API that may change between releases; the plugin is re-tested on updates.
- `python3` on PATH: the two command hooks, the installer and the weekly totals.
- Optional: `gh`, logged in with `gh auth login`. Only the GitHub parts need it: the pull request and CI segments and
  the Work pane.
- Optional, per stack: `go` (for `gopls`), `bun` or `npm` (for `tsserver`), and whatever formatters you already use —
  the format hook runs only what is on PATH and stays silent otherwise.

## Design decisions worth knowing before you adopt it

- **Opinionated on purpose.** The rules are written as MUST/NEVER. If one does not fit your repo, delete it — a rule
  you disagree with gets ignored, and an ignored rule teaches the model that rules are optional.
- **Not every pack is equally proven.** The Go, TypeScript/Nuxt, TiDB and CI packs come from a production monorepo
  and its review history. The others are distilled ecosystem knowledge — each rule is a well-documented, widely hit
  failure mode, written in the same shape, but not validated against *this* team's incidents.
  [`docs/measurements.md`](plugins/simple/docs/measurements.md) says exactly which is which.
- **The rule templates use generic `paths:` globs.** A glob that matches nothing loads nothing, silently. Adjust them
  to your layout: `rg --files -g '<the glob>' | head`.
- **The permission lists are a starting point.** Remove from `deny` deliberately rather than working around it one
  prompt at a time. Note one choice you may disagree with: there is **no blanket `rm -rf *` deny**, because it also
  blocks `rm -rf node_modules` and gets the whole file deleted by the first developer who hits it. Only the forms
  that are never legitimate are denied (`/`, `~`, `$HOME`, `..`). Add the blanket rule back if your team runs with
  `bypassPermissions`.
- **Nothing here claims to make the model smarter.** It makes it cheaper and more honest: fewer tokens spent finding
  things, the right trap file loaded at the right moment, and a gate that refuses to call something green without
  output.

## Contributing a pack

A new language, framework or ORM is **one Markdown file** under `plugins/simple/templates/rules/<category>/` — and,
for a new language, a permissions fragment in `plugins/simple/templates/settings/lang/`. There is no detector to
teach and no list to register in. The bar for a rule: **would a competent colleague get this wrong without being
told?** If not, it does not go in.

## Developing the plugin

From the repository root:

```bash
claude --plugin-dir plugins/simple                                    # the working copy; reloads on save
claude plugin validate --strict plugins/simple
claude plugin test plugins/simple                                     # the TypeScript suites
python3 -m unittest discover -s plugins/simple/tests -p 'test_*.py'   # the Python suites
```

## Licence

MIT. See [LICENSE](LICENSE).
