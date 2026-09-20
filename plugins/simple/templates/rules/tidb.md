---
paths:
  - "**/migrations/**"
  - "**/*.sql"
  - "**/atlas.hcl"
---
# TiDB / schema

## The rule that outranks the rest
**A live database changes only by an additive delta.** New column, new table, new index — never a destructive rewrite
dressed up as a migration. `DROP`, a reset, a "recreate and reimport", or deleting the volume/PVC are not migration
steps; they are outages with data loss. If a change genuinely cannot be additive, that is a decision for a human, in
writing, with a backup verified *before* anything runs.

A safe column addition is three deploys, not one: add the column nullable → backfill and start writing it → make it
required once every row has a value. Trying to do it in one step breaks every process still running the old binary.

## TiDB specifics that bite
- **It is not MySQL.** DDL is online but asynchronous; a migration returning does not mean every node sees the new
  shape yet. Code that writes to a brand-new column must tolerate the old shape for one deploy.
- **No foreign key enforcement** in most deployments: referential integrity is the application's job. A dangling id is
  a real possibility, so the code must handle "the row this id points at is gone".
- **`AUTO_INCREMENT` is not gapless or globally ordered** — ids can jump and can arrive out of order across nodes.
  Never derive ordering, counting or business meaning from them. Use an explicit timestamp or a UUID.
- Distributed transactions have a size limit: a single statement touching millions of rows fails or stalls. Backfill in
  batches with an explicit bound, never `UPDATE ... WHERE 1=1`.
- `SELECT ... FOR UPDATE` works but pessimistic locking behaviour differs from MySQL's. Prefer idempotent writes and a
  uniqueness constraint over a lock held across round trips.

## Indexes
- Every query that filters by a column in a table above a few thousand rows needs an index for that filter, in the
  order the predicate uses. Check with `EXPLAIN`, not by intuition.
- Adding an index to a large live table is itself a migration with a cost — measure it on a copy first.
- A `deleted_at IS NULL` filter belongs *in the index* if soft deletes are the norm, otherwise every read scans the
  deleted rows too.

## Testing a schema change
- Local: apply migrations to a fresh database and run the suite. A migration that only works on your already-migrated
  laptop is not a migration.
- The filter you think SQL is applying (`deleted_at`, a status, a tenant id) is only proved by a test against a real
  database. An in-memory fake proves your fake, not the query.
