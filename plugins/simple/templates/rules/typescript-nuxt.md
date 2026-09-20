---
paths:
  - "**/*.ts"
  - "**/*.tsx"
  - "**/*.vue"
  - "**/nuxt.config.ts"
---
# TypeScript / Nuxt

## Navigation
- Glob-scoped `rg` first (`--glob '*.vue'`, `--glob '*.ts'`), then `sed -n` on the region. Never read a whole file.
- The `LSP` tool (`typescript-lsp`) works from a **position**, replacing your second grep — see the `go` rule for why
  it must be loaded in the same block as your first search, and never used as a file map.
- **`.vue` files have no SFC language server.** For those it is `rg` plus the app's `typecheck`.
- In a monorepo with a shared base layer: a file opened directly from the base reports `Cannot find name '<composable>'`
  because the base has no tsconfig of its own. That is a false positive — navigate from the consuming app, whose
  `goToDefinition` reaches into the base.
- Auto-imports only resolve in apps with a generated `.nuxt/`. Run the project's prepare/install task before believing
  a "not found".

## Types
- No `any` to silence the compiler. If the shape is genuinely unknown, `unknown` plus a narrowing check.
- No `@ts-ignore` / `@ts-expect-error` without a comment saying what is being suppressed and why.
- The **typecheck is the proof**, not the editor: `bun run typecheck` (or the project's equivalent) on the app you
  touched, with real output.

## UI text
- **Every user-visible string goes through i18n.** A hardcoded string in a template is a defect, even in a prototype:
  it will be found six months later by a translator, not by you.
- Adding a key means adding it to every locale the project ships.
- Locale JSON files are huge. Find a key with `rg -n '"the.key"' path/to/locale.json` and edit that line — never open
  the file.

## Styling
- Use the design system's semantic tokens (`primary`, `error`, `muted`, …). A raw palette class bypasses dark mode and
  the brand, and it is the most common reason a front-end diff gets sent back.
- Check whether the component already exists before writing a new one. A near-duplicate is a defect, not a feature.

## Data fetching
- `useAsyncData` / `useFetch`: a 4xx is a **server answer**, not a network failure. Classifying it as offline shows the
  wrong empty state to a user whose request was simply rejected.
- Anything touching `window`, `localStorage` or `document` needs a client guard, or it breaks the moment the page is
  prerendered.
- Cache keys must include every variable the request depends on, or two different requests share one answer.
