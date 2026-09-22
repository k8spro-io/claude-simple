---
paths:
  - "**/*.aggregate.*"
  - "**/mongo/**"
  - "**/mongodb/**"
---
# MongoDB (engine level)

Driver and ODM specifics are in `orm/mongoose`. This is about the database.

## Modelling is the whole decision
- Embed what is read together and is bounded; reference what grows without bound. A document is capped at 16 MB, and an array that only ever grows will reach it in production, not in testing.
- There is no join at query time other than `$lookup`, which cannot use an index on the joined side as freely as you would like. If most queries need three `$lookup` stages, the data is relational and it is worth saying so out loud.
- Design the schema around the queries you actually run. Duplication is normal here; the cost is that every copy must be updated in one operation.

## Correctness
- **Writes are not durable unless you ask.** `writeConcern: { w: "majority" }` for anything that matters; the default can acknowledge before replication and a failover loses it.
- Reads from a secondary are stale by design. Read-your-own-write needs the primary or a causal-consistency session.
- Multi-document transactions require a replica set, are limited to 60s by default, and every operation must carry the session. They are the exception; the normal answer is a document boundary that makes the write atomic.
- Atomic update operators (`$inc`, `$set`, `$push`, `$addToSet`) instead of read-modify-write in application code.
- Uniqueness comes from a unique index, created in a migration and verified in production. A check-then-insert is a race.

## Queries
- Every filtered or sorted field needs an index, in a compound order that matches the query (equality, then sort, then range). `.explain("executionStats")` — an `IXSCAN` with `totalDocsExamined` near the collection size means the index is not doing what you think.
- An unindexed sort above 32 MB fails outright.
- Projections: fetch the fields you use. Documents are returned whole otherwise.
- `$regex` without a prefix anchor cannot use an index. A case-insensitive regex never can — store a normalised field instead.

## Operations
- Schema changes are application-level: both shapes exist at once during a rollout, so the code reads old and new until the backfill finishes.
- A backfill is a batched, resumable script — not one `updateMany` over a 50-million-document collection.
