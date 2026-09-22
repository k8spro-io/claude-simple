---
paths:
  - "**/*.cs"
  - "**/*.csproj"
  - "**/*.sln"
---
# C# / .NET

## Navigation
- Map a file: `rg -nE '^\s*(public|internal|private|protected|static|async|class|record|interface|enum) ' Thing.cs`.
- NEVER read `bin/`, `obj/`, `packages/`, or generated `*.g.cs`.

## Async, and the two ways it goes wrong
- **`async void` is unrecoverable.** The exception is thrown on the thread pool and takes the process down; only an event handler may use it. Everything else returns `Task`.
- `.Result` / `.Wait()` / `GetAwaiter().GetResult()` on a task deadlocks under a synchronization context and starves the pool everywhere else. Async all the way up.
- `ConfigureAwait(false)` in library code; in ASP.NET Core it is unnecessary but harmless.
- Pass the `CancellationToken` down to every call that takes one. A request that the client abandoned should stop working, especially the database call.

## Nullability and types
- `<Nullable>enable</Nullable>` in the project file, and warnings as errors for nullable in new code. The `!` operator is an assertion — justify it or remove it.
- `struct` copies on assignment: a mutable struct in a collection modifies the copy, not the element.
- `IEnumerable` is lazy: enumerating twice runs the query twice (and against EF Core, hits the database twice). Materialize with `ToList()` once you need it more than once.

## Dependency injection lifetimes
- **A scoped service captured by a singleton is a bug** (`DbContext` in a singleton is the classic): it outlives its scope, is shared across requests and is not thread safe. In development, `ValidateScopes` catches it — leave it on.
- `IHttpClientFactory`, never `new HttpClient()` per request (socket exhaustion) and never one static `HttpClient` with no handler lifetime (stale DNS).

## Errors
- Exceptions are typed and mapped once, in middleware. `catch (Exception)` that logs and continues writes wrong data.
- `throw;` preserves the stack trace; `throw ex;` destroys it.

## Tests
- xUnit/NUnit with a real database (Testcontainers) for anything EF Core touches — the in-memory provider does not enforce constraints and translates LINQ differently. See the `orm/efcore` rule.
- A test that never ran red proves nothing.

## Local gate
- `dotnet build -warnaserror && dotnet test` on the touched projects, `dotnet format --verify-no-changes` for style.
