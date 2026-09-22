---
paths:
  - "**/*.model.ts"
  - "**/*.schema.ts"
  - "**/models/**/*.js"
  - "**/schemas/**/*.ts"
---
# Mongoose / MongoDB (Node)

## The schema is the only validation you have
- MongoDB enforces nothing by itself. Every field that matters has a type, `required`, and a sane default in the schema — and `strict` stays on, or a typo in a field name writes a new field instead of failing.
- **Validators do not run on `findOneAndUpdate` / `updateOne` by default.** Pass `runValidators: true`, and remember that `$set` validators only see the fields being set.
- A unique **index** is not a validation: it must exist in the database. `unique: true` in the schema only asks Mongoose to create the index, and `autoIndex` is (correctly) off in production — so create it in a migration and verify it exists.

## Queries
- `findOne` returns `null` for no match; `findById` with a malformed id throws a `CastError` — a 400, not a 500.
- Mongoose documents are heavy. `.lean()` for reads you only serialise: it returns plain objects and is several times faster, but loses getters, virtuals and `save()`.
- `populate` is a **second query per path** (an N+1 by design) and it cannot filter on the joined collection. If you find yourself populating three levels, the data model is relational and the aggregation pipeline (`$lookup`) or a different store is the answer.
- Embedded vs referenced is the modelling decision: embed what is read together and bounded, reference what grows unbounded. A document has a 16 MB limit and an array that grows forever will reach it.
- Every query that filters or sorts on a field in a collection above a few thousand documents needs an index for it. `.explain("executionStats")` tells you; intuition does not.

## Writes and concurrency
- Atomic operators (`$inc`, `$push`, `$set`) instead of read-modify-write. Two requests reading and saving the same document lose one of the writes.
- Multi-document transactions exist on replica sets only, have a 60s limit, and every operation inside must pass the `session`. If you need them constantly, reconsider the document boundaries.
- `bulkWrite` for batches; a loop of `save()` over 1,000 documents is 1,000 round trips.

## Tests
- `mongodb-memory-server` is the real engine and is fine. Assert the indexes exist — that is the part that silently differs from production.
