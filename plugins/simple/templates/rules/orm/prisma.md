---
paths:
  - "**/schema.prisma"
  - "**/prisma/**"
---
# Prisma (TypeScript)

## Client lifecycle
- **One `PrismaClient` per process.** A new client per request exhausts the connection pool within minutes; in dev with hot reload, cache it on `globalThis`.
- The pool size is in the connection string (`connection_limit`). In a serverless environment, every instance opens its own pool — use the project's pooler (PgBouncer, Data Proxy, Accelerate) or the database runs out of connections at the worst moment.
- `$disconnect()` on shutdown, not after each query.

## Queries
- `findUnique` returns `null` for no rows; `findUniqueOrThrow` throws `P2025`. Errors are codes (`P2002` unique violation, `P2003` FK violation) — match on `e.code`, never on the message.
- **`include` and `select` are exclusive at the same level**, and a nested `include` without a `select` fetches every column of the relation.
- Relations are **not** loaded unless asked for. A loop that awaits a query per item is an N+1 you wrote by hand; use `include`, or one `findMany` with `in`.
- `$transaction([...])` batches independent queries; `$transaction(async (tx) => ...)` gives you a transaction — inside it, every call must use `tx`, not the client, or it runs outside the transaction on another connection. Interactive transactions have a **timeout** (5s by default) and holding one across an HTTP call will exceed it.
- `$queryRaw` with a template literal is parameterised; `$queryRawUnsafe` with concatenation is an injection. Identifiers cannot be parameterised — whitelist them.

## Schema and migrations
- `prisma db push` is for prototyping: it can drop columns to reach the desired shape. Anything that ships uses `prisma migrate` with the SQL committed and reviewed.
- Read the generated SQL before applying it. A rename is detected as drop + add, and that is data loss.
- After changing the schema: `prisma generate`, then typecheck. A stale client is the cause of most "property does not exist" errors.

## Tests
- Test against a real database (Testcontainers or a per-run schema). Mocking the client proves the mock; `prisma-mock` cannot enforce a constraint, which is usually the behaviour under test.
