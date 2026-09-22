---
paths:
  - "**/*.sql"
  - "**/migrations/**"
  - "**/postgresql.conf"
---
# PostgreSQL

Read `db/sql` first — this is what is specific to Postgres.

## Locks during migrations (the usual production incident)
- `ALTER TABLE` takes an `ACCESS EXCLUSIVE` lock. It is fast for a nullable column with no default, and a full table rewrite for a type change, a `SET NOT NULL` on an old version, or adding a volatile default.
- **A migration that waits for a lock blocks every query queued behind it.** Always set a short `lock_timeout` (and retry) rather than letting the migration queue the whole application: `SET lock_timeout = '3s';`.
- `CREATE INDEX CONCURRENTLY` does not block writes, but it cannot run inside a transaction — most migration tools need an explicit flag for that, and a failed concurrent index leaves an `INVALID` index behind that must be dropped.
- Adding a foreign key validates the whole table: add it `NOT VALID`, then `VALIDATE CONSTRAINT` separately.

## Types and behaviour
- `timestamptz`, never `timestamp`, for anything that is a point in time. `timestamp` silently drops the offset and the bug appears twice a year.
- `text` with a check constraint instead of `varchar(n)`; there is no performance difference and widening a `varchar` is a migration.
- `numeric` for money. `float`/`double` cannot represent 0.10 and will round your ledger.
- `jsonb` (indexable) not `json`. A field queried often belongs in a column — JSON is for data you store and return, not for data you filter on.
- `NULL` is not equal to anything, including itself: `NOT IN (SELECT ... )` returns no rows if the subquery contains a NULL. Use `NOT EXISTS`.
- `citext` or a functional index (`lower(email)`) for case-insensitive uniqueness — a unique index on `email` does not stop `User@x.com`.

## Concurrency
- `SELECT ... FOR UPDATE` locks the rows; `FOR UPDATE SKIP LOCKED` is how you build a queue without a lock convoy.
- `INSERT ... ON CONFLICT DO NOTHING/UPDATE` is the race-free upsert. A check-then-insert is not.
- Advisory locks for cross-process coordination, released explicitly — they survive the statement, not the crash.
- Long-running transactions block autovacuum, and the table bloats. A transaction left open by an idle connection is a slow outage.

## Performance
- `EXPLAIN (ANALYZE, BUFFERS)` on the real data shape. A plan on 100 rows tells you nothing about 10 million.
- A sequential scan is not automatically wrong; an index that is never used is pure write cost. Check `pg_stat_user_indexes`.
- Partial (`WHERE deleted_at IS NULL`) and covering (`INCLUDE`) indexes are usually the cheapest wins.
- Connection pooling is mandatory in front of Postgres: each connection is a process. PgBouncer in transaction mode forbids session state — prepared statements and `SET` need care.
