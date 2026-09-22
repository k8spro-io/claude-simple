---
name: code-navigation
description: Finding code in any language while spending the fewest tokens — scoped ripgrep first, sed -n on the region second, never a whole-file read, plus the per-language command to map a file. Use before any search or read in a codebase.
---

# Code navigation — grep first

Answer "where is this defined / who calls it / what type is it" **without** reading whole files. A whole-file read of a 2,000-line source costs more than the entire edit you are about to make, and a repo-wide unscoped `grep` costs more than both.

## The order, every time

1. **`rg` to locate** — returns the line only, always with `-n` and always scoped (`--type`, `--glob`, or a directory).
2. **`rg -A/-B` or `sed -n 'START,ENDp'` to read the region** — never the file.
3. **`Read` with `offset`/`limit`** when you need more context around it.
4. **Whole file only** if it is under ~200 lines, or you are about to rewrite all of it.

```bash
rg -n --type go 'func \(.*\) CreateThing\(|^func CreateThing\('   ./internal
rg -n --type go 'CreateThing\(' ./internal --glob '!*_test.go'    # callers, no tests
sed -n '547,610p' internal/things/service.go                      # just the body
```

## Mapping a file instead of opening it

| Language | Command |
|---|---|
| Go | `rg -nE '^(func\|type) ' f.go` |
| Java / Kotlin / C# | `rg -nE '^\s{0,4}(public\|private\|protected\|internal\|class\|interface\|record\|enum\|fun) ' f` |
| Python | `rg -nE '^\s*(async def\|def\|class) ' f.py` |
| TypeScript / JS | `rg -nE '^(export )?(async )?(function\|class\|const\|interface\|type) ' f.ts` |
| Rust | `rg -nE '^\s*(pub )?(async )?(fn\|struct\|enum\|trait\|impl\|mod) ' f.rs` |
| PHP | `rg -nE '^\s*(class\|interface\|trait\|function\|public\|private\|protected) ' f.php` |
| Ruby | `rg -nE '^\s*(class\|module\|def\|scope\|has_many\|belongs_to) ' f.rb` |
| Elixir | `rg -nE '^\s*(defmodule\|def \|defp \|schema )' f.ex` |
| Swift / Scala | `rg -nE '^\s*(final \|public \|private )?(class\|struct\|enum\|protocol\|extension\|object\|trait\|func\|def) ' f` |
| C / C++ | `rg -nE '^[A-Za-z_].*\(\|^(class\|struct\|namespace\|template)' f.cpp` |
| Vue / Svelte | `rg -n 'defineProps\|defineEmits\|export let\|\$props\|<script' f` |
| Anything else | `rg -nE '^[A-Za-z_@(]' f \| head -40` |

## Shortcuts that actually save

- **Exclude tests when hunting production code** (`--glob '!*_test.go'`, `'!*.test.ts'`, `'!test_*.py'`, `'!*_spec.rb'`). In a mature package there are often more test files than production ones. Invert it when the test *is* what you want.
- **Find the traps before you fall in them.** Once per repo, list what must never be read whole:
  ```bash
  find . -type f \( -name '*.go' -o -name '*.ts' -o -name '*.vue' -o -name '*.py' -o -name '*.java' -o -name '*.rb' -o -name '*.cs' \) \
    -not -path '*/node_modules/*' -not -path '*/vendor/*' -not -path '*/.venv/*' -not -path '*/target/*' \
    -size +80k -exec ls -lh {} \; | sort -k5 -h
  ```
  A 150 KB file is roughly 37k tokens. Put the list in the project's instruction file so nobody rediscovers it.
- **i18n locale files and generated code are the worst offenders.** Find the key with `rg -n '"the.key"' path/to/locale.json` and edit that line — never open the JSON. Generated files (`ent/`, `*.g.dart`, `*.sql.go`, `schema.rs`, `*_pb2.py`) are edited at their source, never directly.
- **Never scan** `node_modules/`, `vendor/`, `.venv/`, `target/`, `build/`, `bin/`, `obj/`, `dist/`, `.output/`, `.nuxt/`, `.git/`. Deny them in settings so it cannot happen by accident (`/simple:setup` does this).

## Anti-patterns

| Don't | Do |
|---|---|
| `Read` a 2,000-line file to change 3 lines | `rg -n` finds the line → `sed -n` / `Read` with `offset` |
| Re-read a file after editing "to check" | `Edit` fails if it did not apply — the harness tracks file state |
| `grep -r` across the repo with no filter | `rg -n --type <lang>`, scoped to a directory |
| Map or read code yourself in the orchestrating session | Dispatch a lean, read-only haiku worker (`omitClaudeMd: true`) — it is cheaper than the orchestrator's own model doing it |

## Type checking (the build, not the editor)

The compiler is the proof, and it is the same in every language: run the project's own check on what you touched and read the real output. Go `go build ./... && go vet ./...`; TS `tsc --noEmit`; Python the project's `mypy`/`pyright`; Java `mvn -q -DskipTests compile`; Rust `cargo check`; C# `dotnet build`. Template languages (`.vue`, `.svelte`, Blade, ERB) have no reliable language server — their typecheck script **is** the proof.

## Appendix — when the LSP tool is worth it

Claude Code ships language-server plugins (`gopls-lsp`, `typescript-lsp`). They are **deferred tools**: loading one costs a turn, via `ToolSearch("select:LSP")`.

Measured across a large sample of real sessions: loading the LSP **in its own turn produces a net loss** in input tokens. Breaking even needs roughly 20 symbol lookups in a session, and the median session has 2.

So the rule is:

- Emit `ToolSearch("select:LSP")` **in the same block** as your first `Bash`/`Grep` call of the session, never as a standalone turn.
- Use it only when you already **have a position**: `goToDefinition`, `findReferences`, `incomingCalls`, `hover` (51–413 characters each). It replaces your *second* grep; it must not be added on top of it.
- `workspaceSymbol` only for identifiers of 12 characters or more — shorter ones return a wall of matches.
- **Never use `documentSymbol` as a file map.** It was 76% of all LSP output in the measurement (mean 7.9k characters, peak 25k). The `rg` one-liners above do the same job for half the price.
- Template and SFC files have no language server. Use `rg` plus the typecheck.
