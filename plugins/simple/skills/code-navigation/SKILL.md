---
name: code-navigation
description: How to find code in a Go / Nuxt / TypeScript repo while spending the fewest tokens — scoped ripgrep first, sed -n on the region second, never a whole-file read; plus when the LSP tool is cheaper than grep and when it is not. Use before any search or read in a codebase.
---

# Code navigation — grep first

Answer "where is this defined / who calls it / what type is it" **without** reading whole files. A whole-file read of a
2,000-line source costs more than the entire edit you are about to make, and a repo-wide unscoped `grep` costs more
than both.

## The order, every time

1. **`rg` to locate** — returns the line only, always with `-n` and always scoped (`--type`, `--glob`, or a directory).
2. **`rg -A/-B` or `sed -n 'START,ENDp'` to read the region** — never the file.
3. **`Read` with `offset`/`limit`** when you need more context around it.
4. **Whole file only** if it is under ~200 lines, or you are about to rewrite all of it.

```bash
# a Go symbol's definition
rg -n --type go 'func \(.*\) CreateThing\(|^func CreateThing\(' ./internal

# callers only, skipping tests
rg -n --type go 'CreateThing\(' ./internal --glob '!*_test.go'

# read just the body you found
sed -n '547,610p' internal/things/service.go

# map a big file before opening it: top-level declarations
rg -nE '^(func|type) ' internal/booking/repository.go

# Vue / TS
rg -n --glob '*.vue' 'ThingSwitcher' app/
rg -n --glob '*.ts' 'useApi\(' app/
```

## Shortcuts that actually save

- **`--glob '!*_test.go'`.** In a mature Go package there are often more test files than production ones; without the
  filter most hits are tests. Invert it (`--glob '*_test.go'`) when the test *is* what you want.
- **Find the traps before you fall in them.** Once per repo, list what must never be read whole:
  ```bash
  find . -type f \( -name '*.go' -o -name '*.vue' -o -name '*.ts' \) \
    -not -path '*/node_modules/*' -not -path '*/.nuxt/*' -size +80k -exec ls -lh {} \; | sort -k5 -h
  ```
  A 150 KB file is roughly 37k tokens. Put the list in your project's `AGENTS.md` so nobody rediscovers it.
- **i18n locale files** are the worst offenders (hundreds of KB of JSON). Find a key with
  `rg -n '"the.key"' path/to/locale.json` and edit that line — never open the JSON.
- **Never scan** `dist/`, `.output/`, `.nuxt/`, `node_modules/`, `vendor/`, `.git/`. Deny them in settings so it cannot
  happen by accident (`/simple:setup` does this).

## Anti-patterns

| Don't | Do |
|---|---|
| `Read` a 2,000-line file to change 3 lines | `rg -n` finds the line → `sed -n` / `Read` with `offset` |
| Re-read a file after editing "to check" | `Edit` fails if it did not apply — the harness tracks file state |
| `grep -r` across the repo with no filter | `rg -n --type go` / `--glob '*.vue'`, scoped to a directory |
| Delegate a single-file task to a subagent | The subagent pays the whole prefix again — it costs more, not less |

## Type checking (the build, not just the editor)

- Go: `go build ./... && go vet ./...`
- TS/Vue: the app's `typecheck` script. Vue SFCs have no reliable language server, so the typecheck is the real proof.

## Appendix — when the LSP tool is worth it

Claude Code ships language-server plugins (`gopls-lsp`, `typescript-lsp`). They are **deferred tools**: loading one
costs a turn, via `ToolSearch("select:LSP")`.

Measured across a large sample of real sessions: loading the LSP **in its own turn produces a net loss** in input
tokens. Breaking even needs roughly 20 symbol lookups in a session, and the median session has 2.

So the rule is:

- Emit `ToolSearch("select:LSP")` **in the same block** as your first `Bash`/`Grep` call of the session, never as a
  standalone turn.
- Use it only when you already **have a position**: `goToDefinition`, `findReferences`, `incomingCalls`, `hover`
  (51–413 characters each). It replaces your *second* grep; it must not be added on top of it.
- `workspaceSymbol` only for identifiers of 12 characters or more — shorter ones return a wall of matches.
- **Never use `documentSymbol` as a file map.** It was 76% of all LSP output in the measurement (mean 7.9k characters,
  peak 25k). `rg -nE '^(func|type) '` does the same job for half the price.
- `.vue` files have no SFC language server. Use `rg` plus the typecheck.
