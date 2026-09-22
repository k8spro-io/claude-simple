---
paths:
  - "**/*.entity.ts"
  - "**/entity/**/*.ts"
  - "**/entities/**/*.ts"
  - "**/migration/**/*.ts"
  - "**/migrations/**/*.ts"
---
# TypeORM (TypeScript)

## Configuration that bites in production
- **`synchronize: true` drops and recreates columns to match the entities.** It is data loss with a friendly name; it is `false` everywhere except a throwaway local database.
- One `DataSource` per process, initialised once. Entities are registered explicitly (a glob that misses a file gives "No metadata for X was found" at runtime, not at build).
- `migrationsRun` in the app is a deploy-order decision: two instances starting at once will both try to migrate.

## Queries
- Relations are **not** loaded unless you ask: `relations: ['owner']` in the find options, or `leftJoinAndSelect` in the query builder. `eager: true` on the relation makes every query load it, forever.
- `findOne({ where: {...} })` returns `null`; `findOneOrFail` throws `EntityNotFoundError`.
- **`find` with a `where` that has an `undefined` value ignores that condition** — a filter built from an optional request field silently returns everything, including other tenants' rows. Build the where object conditionally and assert it is not empty.
- `save()` on a partial object performs an upsert-ish update that can null columns you did not include; `update()` is the explicit one, and it does not run entity subscribers or cascades.
- The query builder's `where()` replaces; `andWhere()` accumulates. Parameters are named (`:id`) — interpolating a value into the string is an injection.
- `take`/`skip` with joins paginate correctly; `limit`/`offset` paginate the joined rows and give you the wrong page.

## Transactions
- `dataSource.transaction(async (manager) => ...)`, and every repository inside comes from `manager.getRepository(...)`. A repository obtained from the DataSource runs outside the transaction, on another connection.

## Migrations
- Generate (`migration:generate`) then **read the SQL**. A renamed property is generated as drop + add.
- Each migration has a real `down()`, or an explicit throw. Additive against live data.

## Tests
- Real engine, migrations applied. `sqlite: :memory:` accepts SQL Postgres rejects and does not enforce the same constraints.
