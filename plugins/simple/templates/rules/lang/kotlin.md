---
paths:
  - "**/*.kt"
  - "**/*.kts"
---
# Kotlin

Read the `java` rule too when the module is a Spring/JVM service — the transaction, pool and test traps there apply unchanged.

## Null safety is only as good as the boundary
- `!!` is an assertion that the value cannot be null. If you cannot say why, use `?:` with a real failure instead.
- **Platform types (`String!`) from Java libraries bypass null checks silently.** Annotate or wrap at the boundary; a null crosses into Kotlin code and explodes three frames later.
- `lateinit` throws `UninitializedPropertyAccessException`, not NPE — same bug, different search term.

## Coroutines
- **`GlobalScope` is a leak.** Structured concurrency or nothing: use the caller's scope, and cancel with it.
- Blocking IO inside a coroutine blocks a shared dispatcher thread. Wrap it in `withContext(Dispatchers.IO)`, and do not put CPU work there.
- `try/catch` around a `launch` does not catch what the child throws; a `CoroutineExceptionHandler` or `supervisorScope` does. `async` swallows the exception until `await()`.
- **Cancellation is cooperative and it arrives as an exception.** `catch (e: Exception)` inside a coroutine swallows `CancellationException` and the job never dies — rethrow it.
- A suspend function must be cancellation-safe: no partially written state left behind when it is cancelled mid-way.

## Data and API design
- `data class` gives you `equals`/`hashCode` on all properties in the constructor — a mutable `var` in one breaks any `Set`/`Map` it lands in.
- Sealed class or enum for a closed set of states; `when` over a sealed type is exhaustive and the compiler tells you when a case is added.
- Extension functions do not dispatch virtually — an extension on a base type is *not* overridden by a subtype's extension.

## Tests
- Use `runTest` for coroutines, never `runBlocking` with real delays: a test that sleeps is a test that will flake in CI.
- MockK for Kotlin (Mockito stubs final classes badly). A relaxed mock that returns defaults can make the branch under test unreachable — assert the call, not only the result.

## Local gate
- `./gradlew build` (or `detekt`/`ktlint` if the project has them), plus the module's tests. Format with `ktlintFormat`, never by hand.
