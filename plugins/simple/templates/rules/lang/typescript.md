---
paths:
  - "**/*.ts"
  - "**/*.mts"
  - "**/*.cts"
  - "**/tsconfig*.json"
---
# TypeScript (language and Node services)

Front-end framework specifics live in the `front/` rules. This one is about the language and the server side.

## Navigation
- Glob-scoped `rg` first, then `sed -n` on the region. Map a big file with `rg -nE '^(export )?(async )?(function|class|const|interface|type) ' file.ts`.
- The `LSP` tool works **from a position** (`goToDefinition`, `findReferences`, `hover`) and replaces your second grep — never your first, and never as a file map. Load it in the same block as your first search; `ToolSearch` in its own turn costs more than it saves.

## Types
- No `any` to silence the compiler. `unknown` plus a narrowing check, or a proper type.
- `@ts-ignore` / `@ts-expect-error` only with a comment saying what is suppressed and why.
- **A type assertion is not a check.** `data as User` over a parsed JSON body is a lie the compiler believes; validate at the boundary (zod, valibot, io-ts) and infer the type from the schema.
- `strict` on. Without `strictNullChecks` the whole type system is decorative.
- Enable `noUncheckedIndexedAccess` on new projects: `arr[0]` is `T | undefined`, which is the truth.

## Async and errors
- Every promise is awaited or explicitly handled. A floating promise loses its rejection, and in Node an unhandled rejection kills the process.
- `Promise.all` rejects on the first failure and leaves the rest running. Use `allSettled` when partial success is acceptable, and bound the concurrency — 5,000 parallel requests is a self-inflicted outage.
- Errors thrown across an async boundary lose their stack unless you wrap with `new Error(msg, { cause: err })`.
- `catch (e)` types `e` as `unknown`. Narrow it (`e instanceof Error`) before touching `.message`.

## Node service specifics
- Read configuration once, at startup, through a validated schema, and fail fast on a missing variable. `process.env.X!` scattered through the code fails at 3am instead.
- `JSON.parse` on untrusted input is a throw waiting to happen; and a body size limit is not optional.
- Streams and file handles get closed in a `finally`. A leaked handle shows up as a slow memory climb, never as an error.
- ESM vs CJS: `__dirname` does not exist in ESM, and a `require` of an ESM package fails at runtime, not at build. Decide per package and keep `"type"` honest.

## Tests
- Vitest/Jest with real assertions on behaviour, not on the shape of a mock.
- Fake timers for anything time-dependent; a `setTimeout` in a test is a future flake.
- A test that never ran red proves nothing: revert the fix, watch it fail, reapply.

## Local gate
- `tsc --noEmit` (or the app's `typecheck` script) with real output, plus lint and the touched tests.
