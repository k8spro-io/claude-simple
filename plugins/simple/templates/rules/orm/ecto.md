---
paths:
  - "**/lib/**/schema/**/*.ex"
  - "**/lib/**/schemas/**/*.ex"
  - "**/*_repo.ex"
  - "**/priv/repo/migrations/**"
---
# Ecto (Elixir)

## Changesets validate, the database constrains
- A `unique_constraint/3` in the changeset does **not** check anything by itself: it turns the database's constraint violation into a readable error. Without the unique index in a migration, there is no uniqueness — only a race.
- Same for `foreign_key_constraint`, `check_constraint`, `exclusion_constraint`. Every validation that must be true under concurrency has a matching constraint in a migration.
- `cast/4` is a whitelist. Passing the full parameter map with every field allows a client to set whatever exists — including `role` and `account_id`.

## Preloading
- Associations are `NotLoaded` until preloaded; touching one raises rather than lazily querying (which is a feature — there is no accidental N+1).
- `Repo.preload/2` after the fact is a second query; `preload:` inside the query can be a join. A preload inside `Enum.map` is an N+1 you wrote deliberately.
- `Repo.all` returns `[]` for no rows; `Repo.one` returns `nil` and **raises** if there is more than one; `Repo.get!` raises `Ecto.NoResultsError`.

## Multi and transactions
- `Ecto.Multi` is the way to express several steps: it names each one, runs them in a transaction, and returns `{:error, name, value, changes_so_far}` telling you exactly which step failed. A chain of `case` blocks with manual rollbacks does the same thing worse.
- Everything inside `Repo.transaction/1` must use the same repo process; a `Task` spawned inside it runs on another connection and is **not** in the transaction.
- Long transactions hold a pooled connection. The pool (`:pool_size`) is per node — multiply by the number of nodes before comparing it with the database's limit.

## Migrations
- Additive against live data. `create index(..., concurrently: true)` needs `@disable_ddl_transaction true` and `@disable_migration_lock true`, or the deploy takes a write lock on a big table.
- A migration that modifies data uses `execute/2` with explicit SQL or a query built from the **migration's own** schema definitions — not the application schema module, which changes underneath it.

## Tests
- `Ecto.Adapters.SQL.Sandbox` gives each test its own transaction; `async: true` is safe with it, except for tests that need a shared connection (LiveView, background processes) — those use `{:shared, self()}`.
- A test that passes with the fix reverted proves nothing; for a constraint, assert the error, not only the changeset.
