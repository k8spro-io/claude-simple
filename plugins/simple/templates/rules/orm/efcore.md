---
paths:
  - "**/*DbContext.cs"
  - "**/Migrations/**"
  - "**/Entities/**/*.cs"
  - "**/Models/**/*.cs"
---
# Entity Framework Core

## DbContext lifetime
- **`DbContext` is scoped, never a singleton** and never shared between threads. A singleton holding one is the classic .NET data-corruption bug; keep `ValidateScopes` on in development so the container catches it.
- `AddDbContextFactory` for background services and Blazor — they have no request scope.
- One `SaveChangesAsync()` per unit of work, and it is a transaction by itself. Several calls in one operation means a partially applied change when the second fails.

## Query translation is where the surprises live
- **`AsEnumerable()`, `ToList()` or a method EF cannot translate moves the rest of the query into memory** — the database then returns the whole table and your `Where` runs in C#. In EF Core 3+ an untranslatable expression throws instead of silently doing this; do not "fix" it by materialising early.
- `Include` for related data; without it, navigation properties are null (or, with lazy loading proxies enabled, an N+1 you cannot see). Prefer projecting to a DTO with `Select` — it fetches only the columns you need and needs no `Include`.
- `AsNoTracking()` for read-only queries: tracking thousands of entities is both memory and CPU you did not intend to spend.
- `Find` hits the change tracker first (no query if it is already loaded); `FirstOrDefault` always queries.
- `IEnumerable` is lazy: enumerating a query twice runs it twice against the database.

## Concurrency and correctness
- A `[Timestamp]`/`rowversion` column plus a `DbUpdateConcurrencyException` handler is how you avoid last-write-wins. Without it, two users editing the same row silently overwrite each other.
- `ExecuteUpdate`/`ExecuteDelete` (EF 7+) run server-side and **bypass the change tracker** — fast, and the tracked entities are stale afterwards.
- `FromSql` with interpolation is parameterised; `FromSqlRaw` with a concatenated string is an injection.

## Migrations
- `dotnet ef migrations add` generates a draft: **read the `Up`**, especially for renames (generated as drop + add) and for `AlterColumn` that rewrites a table.
- `EnsureCreated()` is not a migration and does not coexist with them. `Database.Migrate()` at startup is a deploy-order decision when you run more than one instance.
- Additive against live data: nullable column → backfill → tighten, across deploys.

## Tests
- The in-memory provider is **not a relational database**: it ignores constraints, does not enforce required relationships, and translates LINQ differently. Use SQLite in-memory for a fast approximation and Testcontainers with the real engine for anything about behaviour the database owns.
