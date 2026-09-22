---
paths:
  - "**/*.sql"
  - "**/migrations/**"
  - "**/migrate/**"
  - "**/atlas.hcl"
---
# SQL and schema change (any engine)

Engine-specific behaviour is in the `db/<engine>` rule; the ORM's own traps are in the `orm/` rule. This is what is true everywhere.

## The rule that outranks the rest
**A live database changes only by an additive delta.** New column, new table, new index — never a destructive rewrite dressed up as a migration. `DROP`, a reset, a "recreate and reimport", or deleting the volume are not migration steps; they are outages with data loss. If a change genuinely cannot be additive, that is a human decision, in writing, with a backup verified **before** anything runs.

A safe column addition is three deploys, not one:
1. add it **nullable**, deploy (old code keeps working);
2. backfill in bounded batches and start writing it;
3. make it required once every row has a value.

Doing it in one step breaks every process still running the old binary, and the rollback breaks the new one.

## Migrations
- One migration per change, committed **with** the code that needs it, named so the order is obvious, and never edited after it has been applied anywhere — edit-in-place is how two environments end up with different schemas and the same version number.
- A migration is reviewed as SQL. Generated migrations are drafts: a rename is almost always emitted as drop + add, which is data loss.
- Every migration is tested by applying it to a **copy of production-shaped data**, not to an empty local database. Time and locks are the two things an empty database cannot show you.
- Backfills are batched with an explicit bound and a resumable cursor. `UPDATE ... WHERE 1=1` on a large table locks it, blows the transaction limit, or both.
- A `down()` is either correct or an explicit refusal. A downgrade that drops a column is a loaded gun.

## Queries
- **Every value is a bound parameter.** Identifiers (table, column, sort direction) cannot be parameterised — whitelist them against a fixed list. A sort column taken from a request is an injection.
- Every filter on a table above a few thousand rows needs an index in the order the predicate uses. Confirm with `EXPLAIN`, never by intuition. Adding an index to a large live table is itself a migration with a cost.
- A soft-delete filter (`deleted_at IS NULL`) belongs **in** the index, or every read still scans the deleted rows.
- `SELECT *` breaks when a column is added and fetches blobs you did not want. Name the columns.
- Pagination by `OFFSET` degrades linearly and skips rows when data shifts; keyset pagination (`WHERE (created_at, id) < (?, ?)`) is stable and constant time.

## Transactions
- A transaction holds a connection: no HTTP calls, no queue publishes, no sleeps inside one. Publish **after** commit.
- Inside a transaction, every read uses the transaction's handle. A read through the pool while a transaction is open checks out a second connection and deadlocks under load.
- Take locks in a consistent order everywhere, and keep the transaction as short as the correctness requires.
- Know your isolation level. "Read committed" means a repeated read can change; a check-then-insert is a race unless a unique constraint backs it.

## What the database owns
Uniqueness, referential integrity and NOT NULL are enforced by constraints, not by application validation. Application-level checks are a better error message for the user; the constraint is the guarantee. Write both, and handle the constraint violation as a business case.
