---
paths:
  - "**/*.clj"
  - "**/*.cljs"
  - "**/*.cljc"
  - "**/deps.edn"
  - "**/project.clj"
---
# Clojure

## Navigation
- Map a namespace: `rg -nE '^\((ns|def|defn|defn-|defmulti|defrecord|defprotocol|s/def) ' src/app/thing.clj`.
- NEVER read `target/`, `.cpcache/`, `node_modules/`, compiled ClojureScript output.

## Laziness is where the bugs are
- A lazy sequence realised outside the scope that owned its resource reads from a closed connection. Force it (`doall`/`into []`) **inside** the `with-open`.
- Side effects inside `map` may never run, or run twice. Use `run!`/`doseq` for effects, `mapv` when you want them now.
- An infinite sequence printed at the REPL, or held by the head in a `let`, is an out-of-memory error.

## Data and state
- Data is immutable; state is one explicit `atom`/`ref` per concern, and the function that swaps it is pure. Several atoms updated together is a consistency bug — use one map, or a `ref` and `dosync`.
- **`swap!` retries**, so the function you pass it must have no side effects.
- Keys are namespaced keywords (`::user/id`) in anything that crosses a boundary; a bare `:id` from two sources silently collides.
- Specs (`clojure.spec`, malli) at the system boundary, instrumented in tests — not in production hot paths.

## Errors
- `ex-info` with a data map, always. An exception carrying only a string cannot be handled programmatically.
- `(try ... (catch Exception e nil))` is the "error as empty result" bug in its shortest form.

## Tests
- `clojure.test` with fixtures; generative tests (`test.check`) for pure transformations.
- A test that never ran red proves nothing.

## Local gate
- `clojure -M:test` (or `lein test`) on the touched namespaces, plus `clj-kondo --lint src test` — it catches arity and shadowing errors the REPL will not.
