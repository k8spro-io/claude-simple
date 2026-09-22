---
paths:
  - "**/*.sql"
  - "**/migrations/**"
  - "**/my.cnf"
---
# MySQL / TiDB

Read `db/sql` first — this is what is specific to these engines.

## MySQL
- **The charset must be `utf8mb4`.** `utf8` in MySQL is three bytes and cannot store an emoji or some CJK characters; the insert fails or truncates.
- A `DATETIME` has no timezone. Store UTC, decide once, and write it down — mixing server timezone and application timezone is a whole class of off-by-hours bugs.
- Collation decides case sensitivity for comparisons **and** for unique indexes; the default `*_ci` means `A` and `a` collide. That is usually what you want for an email and a surprise for a token.
- Most DDL is online in 8.0, but `ALGORITHM=COPY` operations (some type changes, adding a column with a stored default on older versions) rewrite the table and block writes. Check the operation's algorithm before running it in production, or use `gh-ost`/`pt-online-schema-change`.
- `ON DUPLICATE KEY UPDATE` is the race-free upsert. `REPLACE INTO` deletes and re-inserts — it changes the primary key's auto-increment and fires delete triggers.
- A transaction with a deadlock is retried by no one: catch error 1213 and retry the whole transaction, taking locks in a consistent order.

## TiDB
- **It is not MySQL, despite the protocol.** DDL is online but **asynchronous**: a migration returning does not mean every node sees the new shape yet. Code that writes to a brand-new column must tolerate the old shape for one deploy.
- **Foreign keys are not enforced** in most deployments: referential integrity is the application's job, and a dangling id is a real possibility the code must handle.
- **`AUTO_INCREMENT` is neither gapless nor globally ordered.** Ids jump and can arrive out of order across nodes. Never derive ordering, counting or business meaning from them — use an explicit timestamp or a UUID. `AUTO_RANDOM` for a primary key avoids the write hotspot that a monotonic id creates on a single region.
- Distributed transactions have a size limit: one statement touching millions of rows fails or stalls. Backfill in bounded batches, always.
- Pessimistic locking behaviour differs from MySQL's, and a hot row becomes a cross-node conflict rather than a local lock. Prefer idempotent writes and a uniqueness constraint over a lock held across round trips.
- `EXPLAIN ANALYZE` reports per-operator time including coprocessor tasks — a full table scan pushed down still reads the whole region set.
