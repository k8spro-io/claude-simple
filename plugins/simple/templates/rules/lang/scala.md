---
paths:
  - "**/*.scala"
  - "**/*.sbt"
---
# Scala

## Navigation
- Map a file: `rg -nE '^\s*(final |sealed |abstract )?(case )?(class|object|trait|enum|def|val|type) ' src/main/scala/Thing.scala`.
- NEVER read `target/`, `.bloop/`, `.metals/`.

## Correctness
- No `Option.get`, no `head` on a possibly empty collection, no `.right.get`. Fold, pattern-match, or `getOrElse` with a real fallback.
- A `case class` with a mutable field breaks `equals`/`hashCode` and any `Map` it lands in.
- Implicit conversions hide behaviour at the call site; implicit *parameters* are fine. Scala 3: prefer `given`/`using` and keep them in one obvious place.
- `map`/`flatMap` on a `Future` runs on the implicit `ExecutionContext` — passing the global one everywhere means blocking IO and CPU work share the same starved pool.

## Effects
- In a Cats Effect / ZIO codebase, nothing runs until the effect is interpreted at the edge. A `IO` value that is built and discarded does nothing and looks like it worked.
- Never `unsafeRunSync()` outside `main` or a test.
- Resources (connections, files) come from `Resource`/`ZIO.acquireRelease`, never a bare `try/finally` around an effect.

## Collections and performance
- `List` prepends in O(1) and indexes in O(n); `Vector` for random access. A `for` loop over `list(i)` is quadratic.
- `.toSeq`/`.toList` inside a hot loop copies the whole collection each time.

## Tests
- ScalaTest/MUnit; property-based tests (ScalaCheck) earn their keep on parsers, money and encodings.
- A test that never ran red proves nothing.

## Local gate
- `sbt scalafmtCheckAll compile test` on the touched modules. Compiler warnings are the cheapest review: keep `-Xfatal-warnings` on.
