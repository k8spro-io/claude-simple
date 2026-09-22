---
paths:
  - "**/ent/**"
---
# Ent (Go)

## Generated code is not edited
- `ent/` is generated from `ent/schema/*.go`. Editing anything outside `ent/schema/` is overwritten by the next `go generate ./ent`, silently.
- After changing a schema: regenerate, then build. A stale generated package is the source of most "this field does not exist" errors.
- NEVER read the generated files whole — they are enormous. `rg -n 'func \(\w+ \*ThingQuery\)' ent/thing_query.go` if you really need the surface.

## Queries
- `Only(ctx)` errors if there is not exactly one row (`NotSingularError` as well as `NotFoundError`) — handle both. `First` returns `NotFoundError`; `All` returns an empty slice and no error.
- **Eager loading is explicit**: `WithOwner()`, `WithItems()`. Without it, `.QueryOwner()` per row is an N+1 that only shows up under real data.
- `ent.IsNotFound(err)` / `ent.IsConstraintError(err)` instead of comparing strings. A constraint error is often the *correct* outcome of a race — handle it as a business case, not as a 500.
- Predicates are composable and typed; build a filter as `[]predicate.Thing` and apply once, rather than branching over query builders.

## Transactions and hooks
- `client.Tx(ctx)` returns a `*Tx`; every call inside must use `tx.Thing`, never `client.Thing`. Mixing the two is a second connection in an open transaction.
- Commit/rollback is handled in one place (`defer` with a named error, or `WithTx` helper). A rollback that is skipped on an early return leaves the connection checked out.
- Hooks and privacy policies run for every mutation, including the ones your tests do — a privacy rule that denies by default will make a test fail in a way that looks like a bug in the query.

## Migrations
- Versioned migrations (Atlas) for anything that ships. `Schema.Create` with auto-migration is for local development; it does not do backfills and it will not tell you what it is about to run in production.

## Tests
- SQLite in memory is convenient and is *not* the production engine: JSON columns, ON CONFLICT semantics and constraint names differ. Use the real engine for anything that depends on the database enforcing something.
