# claude-simple

A Claude Code plugin marketplace with one plugin, **`simple`**: a lean setup for teams working on
**Go + Nuxt/TypeScript + TiDB**.

Everything in it that makes a cost claim was measured with a hidden-oracle benchmark — including the parts that were
**rejected** after measuring. The findings and the protocol to reproduce them are in
[`plugins/simple/docs/measurements.md`](plugins/simple/docs/measurements.md).

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

That command shows you a dry run first, then installs only what you pick.

## What you get

**Immediately, from the plugin itself:**

| | |
|---|---|
| `/simple:setup` | installs the project-level pieces a plugin cannot ship by itself |
| skill `code-navigation` | grep-first navigation for Go/Vue/TS, and when the LSP is actually cheaper |
| skill `cost-per-fix` | how to measure a tool before adopting it — and the trap that invalidates most benchmarks |
| skill `delivery-gate` | what must be true before saying "done", "green" or "deployed" |
| skill `adr` | decision records: numbering, the template, and amending without rewriting |
| agent `wf-reader` | read-only worker: maps code, reviews a diff, answers with `file:line` |
| agent `wf-implementer` | Go worker: applies the change, proves it with a test that was seen red |
| agent `front-implementer` | Nuxt/TS worker: i18n, semantic tokens, typecheck as proof |
| agent `diff-reviewer` | adversarial review pass, deliberately without `Edit`/`Write`/`Bash` |
| hook `read-budget` | blocks a whole-file read of a huge file and hands back the cheap recipe |
| hook `format-on-edit` | `gofmt` / `eslint --fix` on what was just edited |

**From `/simple:setup`, into your project:**

- `.claude/settings.json` — permissions (irreversible commands denied, build output and credentials unreadable, the
  read-only shell pre-approved), `autoCompactWindow`, and the Workflow concurrency cap at 4. Every entry is justified
  in [`docs/permissions.md`](plugins/simple/docs/permissions.md), including what these lists **cannot** protect you
  from: `deny` beats `allow` with no override, a `Read()` deny also blocks `Edit`/`Write` on that path, and a `Read()`
  deny does not stop `cat`. They are speed bumps against accidents, not a sandbox.
- `.claude/rules/` — `go`, `typescript-nuxt`, `tidb`, `taskfile`, `ci`. Rules load themselves when a tool touches a
  matching path, so they cost nothing until they are relevant.
- **LSP enabled**: `gopls-lsp` and `typescript-lsp` from the official marketplace, plus the language servers they
  drive (`gopls`, and `tsserver` from TypeScript **6.x** — 7.x ships no tsserver and the LSP fails).
- **Statusline**: model, effort, context bar, cache hit ratio, session cost, 5h/7d limits, and weekly usage per model.
- `templates/AGENTS.md` — a skeleton for the instruction file, offered, never written without asking.

Everything merges. A file you already have is kept, and re-running converges instead of duplicating.

## What it costs you

Measured with `claude plugin details simple`, on the machine this was built on:

```
Always-on:   ~840 tok   added to every session
```

That is the price of the skill and agent listings being available. A skill or agent only costs its full text when it
actually fires (`code-navigation` ~1.5k, `cost-per-fix` ~1.4k, the rest under 1k). The hooks cost nothing in context —
they run in the harness.

If ~840 tokens per session is not worth it to you, install nothing and copy the two or three files you want instead.
The measurement document exists so you can make that call with numbers.

## Requirements

- Claude Code with plugin support, and `python3` on PATH (hooks, installer and statusline).
- Optional: `go` (for `gopls`), `bun` or `npm` (for `tsserver`), `git` and `gh`.

## Design decisions worth knowing before you adopt it

- **Opinionated on purpose.** The rules are written as MUST/NEVER, from review findings that actually happened. If one
  does not fit your repo, delete it — a rule you disagree with gets ignored, and an ignored rule teaches the model
  that rules are optional.
- **The rule templates use generic `paths:` globs.** A glob that matches nothing loads nothing, silently. Adjust them
  to your layout.
- **The permission lists are a starting point.** Remove from `deny` deliberately rather than working around it one
  prompt at a time. Note one choice you may disagree with: there is **no blanket `rm -rf *` deny**, because it also
  blocks `rm -rf node_modules` and gets the whole file deleted by the first developer who hits it. Only the forms that
  are never legitimate are denied (`/`, `~`, `$HOME`, `..`). Add the blanket rule back if your team runs with
  `bypassPermissions`.
- **Nothing here claims to make the model smarter.** It makes it cheaper and more honest: fewer tokens spent finding
  things, and a gate that refuses to call something green without output.

## Licence

MIT. See [LICENSE](LICENSE).
