---
paths:
  - "**/drizzle.config.*"
  - "**/drizzle/**"
  - "**/schema.ts"
  - "**/db/**/*.ts"
---
# Drizzle ORM (TypeScript)

## The schema file is the contract
- Tables, columns and relations are declared in TypeScript; the types flow from there. A column type that does not match the database (a `text` declared as `integer`) compiles happily and fails at runtime.
- `relations()` is only for the relational query API (`db.query.users.findMany({ with: ... })`). The SQL builder (`select().from().leftJoin()`) ignores it — two different APIs, two different mental models. Pick one per repository layer.

## Queries
- A `.where()` with two conditions needs `and(...)` — passing two arguments silently keeps one.
- **A left join returns `null` for the joined side**, so the inferred type is nullable: handle it instead of asserting it away with `!`.
- `db.select()` without a projection selects every column of every joined table; name the columns for anything that runs per request.
- Raw fragments go through `sql` template literals (parameterised). `sql.raw()` with anything from a request is an injection.
- The relational API's `with` issues one additional query per relation level — fine, but it is not a join; check the plan for list endpoints.

## Transactions
- `db.transaction(async (tx) => ...)`: every statement inside uses `tx`. A call on `db` inside the callback runs on a **different connection**, outside the transaction, and will deadlock against it.
- Returning early from the callback commits; throwing rolls back. There is no silent "partial commit" — make sure the error propagates rather than being caught and logged.

## Migrations
- `drizzle-kit generate` writes SQL you are expected to **read**. `drizzle-kit push` applies a diff directly and can drop a column to match the schema — never against a database with data that matters.
- The generated SQL and the snapshot are committed together; a missing snapshot makes the next diff wrong.
- Additive changes only against a live database: add nullable → backfill → tighten. See the `db/sql` rule.

## Tests
- Against the real engine, with migrations applied from the committed SQL. That also proves the migrations run — which is the half that usually breaks.
