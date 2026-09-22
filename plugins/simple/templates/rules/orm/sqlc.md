---
paths:
  - "**/sqlc.yaml"
  - "**/sqlc.json"
  - "**/query.sql"
  - "**/queries/**/*.sql"
---
# sqlc (Go, SQL-first)

## The SQL file is the source of truth
- Change the `.sql`, run `sqlc generate`, then build. Editing the generated `.go` is overwritten and undetectable in review.
- The generated file is huge and mechanical: never read it whole. `rg -n 'func \(q \*Queries\)' db/queries.sql.go` lists the surface.
- A query's name and its comment (`-- name: GetThing :one`) define the generated signature. `:one` returns `sql.ErrNoRows` for zero rows; `:many` returns an empty slice and no error.

## Correctness
- **Every parameter is a placeholder.** sqlc cannot parameterise an identifier: a dynamic `ORDER BY` or table name means either a whitelist in Go or a hand-written query — never string concatenation.
- `NULL` becomes a nullable type (`sql.NullString`, `pgtype.Text`). Code that dereferences it without checking `.Valid` writes an empty string where the business meant "unknown".
- `IN (...)` with a slice needs the driver's array support (`= ANY($1)` on pgx) — not a comma-joined string.
- A query that returns `SELECT *` breaks the moment a column is added. List the columns.

## Transactions
- `q.WithTx(tx)` returns a `*Queries` bound to the transaction. Every call inside the transaction uses **that** value; calling the pool-bound `q` inside an open transaction is a second connection.
- The transaction is opened, committed and rolled back in one function with `defer tx.Rollback()` — rollback after commit is a no-op and is the correct shape.

## Schema and migrations
- sqlc reads the schema from the migration files, so **the migrations are the schema**. A drift between the database and those files produces generated code that compiles and fails at runtime.
- Run `sqlc vet` (or at minimum regenerate) in CI: a query that no longer matches the schema must break the build, not production.

## Tests
- These are real SQL queries; test them against the real engine. There is nothing to mock that would prove anything — a fake `Queries` interface proves your fake.
