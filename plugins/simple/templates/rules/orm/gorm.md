---
paths:
  - "**/model/**/*.go"
  - "**/models/**/*.go"
  - "**/repository/**/*.go"
  - "**/repositories/**/*.go"
  - "**/store/**/*.go"
  - "**/dao/**/*.go"
  - "**/db/**/*.go"
---
# GORM (Go)

## The handle is the contract
- **Inside a transaction, every read and write goes through the transaction handle.** A repository method that reaches for the global `*gorm.DB` while a transaction is open checks out a second connection and deadlocks under load.
- `...Tx` variants take the handle as a parameter and **fail loudly on a nil one** — never fall back to the pool "just in case". That fallback is exactly the bug it looks like it prevents.
- `db.WithContext(ctx)` on every call. Without it a cancelled request keeps the query running.

## Query behaviour that surprises people
- `First`/`Take`/`Last` return `gorm.ErrRecordNotFound`; `Find` into a slice returns **no error** for zero rows. Checking `err != nil` after `Find` never detects "nothing matched" — check the length.
- `Updates` with a **struct** skips zero values (`false`, `0`, `""`). To write a zero deliberately, use `map[string]any` or `Select` the columns.
- `Save` on a struct with a zero primary key inserts; with a set one it updates **every** column, including the ones you did not load.
- Soft delete (`gorm.DeletedAt`) silently adds `deleted_at IS NULL` to every query — and `Unscoped()` silently removes it. A unique index must account for soft-deleted rows or the second insert of the same key fails forever.
- Chained conditions are shared until a finisher runs: reusing a `*gorm.DB` built with `Where` across two queries leaks conditions between them. Start from a fresh `db.Model(...)` or use `Session(&gorm.Session{})`.
- `Preload` issues a second query per association (that is the N+1 you can see); `Joins` does one. Neither is free — for a list endpoint, select the columns you need.

## Migrations
- `AutoMigrate` is a development convenience. It never drops or narrows a column, it cannot express a backfill, and running it against a live database is how a deploy takes an unplanned lock. Production schema changes go through the project's migration tool, additively. See the `db/sql` rule.

## The test trap that produced two false-green tests
Under `DryRun`, GORM **skips `Scan`**: `Take`/`First` return a **nil** error and a zero struct, never `ErrRecordNotFound`. A "not found" branch test written with DryRun passes green **even with the fix reverted**.

```go
db.Callback().Query().Before("gorm:query").Register("test:fail", func(tx *gorm.DB) {
    if tx.Statement != nil && tx.Statement.Table == "the_table" {
        _ = tx.AddError(errors.New("invalid connection"))
    }
})
```

DryRun remains the right tool for proving **which SQL was issued on which handle** — it just cannot simulate a missing row. Anything that depends on the database actually applying a filter (soft deletes, tenant scoping, uniqueness) needs a real database in the test.
