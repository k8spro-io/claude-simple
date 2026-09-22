---
paths:
  - "**/*.rs"
  - "**/Cargo.toml"
---
# Rust

## Navigation
- Map a file: `rg -nE '^\s*(pub )?(async )?(fn|struct|enum|trait|impl|mod) ' src/thing.rs`.
- NEVER read `target/`. `cargo doc` output and generated bindings are not source.

## Errors
- Libraries define their own error enum (`thiserror`); binaries use `anyhow` with `.context(...)` at each layer. Do not export `anyhow::Error` from a library — callers cannot match on it.
- `unwrap()` / `expect()` only where the invariant is local and provable, and `expect` says *why* it cannot fail. In a request path, an `unwrap` is a 500 with no message.
- `?` converts through `From`; an error type that cannot carry context produces logs that say "invalid input" with no idea which input.

## Ownership traps that actually bite
- `clone()` to silence the borrow checker hides the real lifetime question. Sometimes it is right — say so in a comment when it is deliberate.
- **Holding a `MutexGuard` across an `.await` deadlocks** or poisons the executor. Drop the guard (scope it) before awaiting, or use an async-aware lock.
- A `std::sync::Mutex` in async code is fine only if the critical section never awaits and is short.
- `Rc`/`RefCell` cycles leak; `Weak` breaks the cycle. `RefCell` turns a borrow bug into a runtime panic.

## Async
- Blocking work inside an async task starves the runtime's worker threads: `tokio::task::spawn_blocking` for CPU or sync IO.
- A dropped future is cancelled at its last await point. Anything that must not be half-done needs to be idempotent or guarded by a transaction.
- `select!` cancels the losing branches — never put a non-restartable operation in one.

## Unsafe
- Every `unsafe` block carries a comment stating the invariant that makes it sound, and it is as small as it can be. `unsafe` in a PR is a review stop-and-read, always.

## Tests
- Unit tests next to the code, integration tests in `tests/`. `#[should_panic]` without `expected = "..."` passes on the wrong panic.
- A test that never ran red proves nothing.

## Local gate
- `cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test` on what you touched. Clippy warnings are the review you get for free — do not silence with `#[allow]` without a reason next to it.
