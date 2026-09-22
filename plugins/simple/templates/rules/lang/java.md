---
paths:
  - "**/*.java"
  - "**/pom.xml"
  - "**/build.gradle"
  - "**/build.gradle.kts"
---
# Java / JVM

## Navigation, before opening a file
- Map a big class instead of reading it: `rg -nE '^\s{0,4}(public|protected|private|static|abstract|final|class|interface|record|enum)' File.java`.
- Find an implementation: `rg -n --type java 'class \w+ implements FooService'`; callers: `rg -n --type java '\.doThing\('`.
- NEVER read or edit `target/`, `build/`, `generated-sources/`. A generated file that is edited is silently overwritten by the next build.

## Errors and nulls
- Do not `catch (Exception e)` to log and carry on. Catching everything turns a bug into corrupted state; catch the specific exception or let it propagate.
- **An exception is not an empty result.** `catch { return Collections.emptyList(); }` reports "no rows" for a dropped connection, and the caller then writes something wrong.
- `Optional` is a return type. Never a field, never a parameter, never `Optional.get()` without `isPresent()` — use `orElseThrow` with a real message.
- Autoboxing a `null Integer` in arithmetic or in a ternary throws NPE at a line that looks harmless. `Map.get` returning `null` inside `int x = map.get(k)` is the usual source.

## Transactions (the trap that costs the most)
- **Spring `@Transactional` self-invocation does nothing.** Calling an annotated method from another method of the *same* bean bypasses the proxy, so there is no transaction at all — and no error. The call must come from another bean, or the annotation is decoration.
- `@Transactional` rolls back on `RuntimeException` only. A checked exception commits unless you write `rollbackFor = Exception.class`.
- Never call an external HTTP service while a transaction (and its connection) is open. The pool empties under load and the whole service stalls.
- `readOnly = true` on reads: it is a hint to the driver and to Hibernate's dirty checking, and it documents intent.

## Concurrency
- `ThreadLocal` in a pooled thread must be cleared in a `finally`, or the next request reads the previous user's value.
- Virtual threads pin the carrier thread inside `synchronized`. Use `ReentrantLock` in code that runs on virtual threads.
- `CompletableFuture` without an executor runs on the common ForkJoinPool; blocking IO there starves every other user of that pool.

## Spring specifics
- Constructor injection, never `@Autowired` on a field: a field-injected dependency cannot be made final and cannot be constructed in a plain unit test.
- Configuration comes from the environment. A secret written into `application.yml` and committed is a published secret.
- Exceptions are mapped in one `@RestControllerAdvice`; a stack trace in a response body is an information leak.

## Tests
- Slices before `@SpringBootTest`: `@DataJpaTest`, `@WebMvcTest`, `@JsonTest`. A full context per test class is where the suite's minutes go.
- **H2 is not your database.** A query with vendor SQL, an index hint, `ON CONFLICT`, JSON operators or a different collation passes on H2 and fails in production. Use Testcontainers with the real engine.
- A test that never ran red proves nothing: revert the change, watch it fail, reapply.

## Local gate
- Maven `mvn -B -q verify` · Gradle `./gradlew build`. Fast compile check: `mvn -q -DskipTests compile`.
- Formatting through the project's plugin (spotless, checkstyle) — run the target, never reformat by hand.
