---
paths:
  - "**/*.zig"
  - "**/build.zig"
---
# Zig

## Navigation
- Map a file: `rg -nE '^\s*(pub )?(fn|const|var|test) ' src/main.zig`.
- NEVER read `zig-out/`, `zig-cache/`, `.zig-cache/`.

## Allocators are the API
- Every function that allocates takes an `std.mem.Allocator` parameter. A function that reaches for a global allocator cannot be tested or embedded.
- Every allocation has a matching `defer allocator.free(...)` / `deinit()` written **immediately** after it, before any early return can be added.
- Tests use `std.testing.allocator`: it fails the test on a leak. That is the cheapest memory-leak detector you will ever get — use it everywhere.
- `errdefer` for cleanup that must only happen on the error path; forgetting it is the standard partial-construction leak.

## Errors and safety
- Error unions are checked by the compiler: `try` propagates, `catch` handles. `catch unreachable` is an assertion that panics in safe builds and is undefined behaviour in `ReleaseFast` — it is not a shortcut.
- `undefined` is not a value: reading it is UB. Initialise, or document why the memory is written before it is read.
- Slices carry a length; keep working with slices instead of pointer + length pairs, and do not index with a value that came from outside without a bounds check.

## Comptime and build
- `comptime` code runs at compile time and its errors appear at the instantiation site — keep it small and give it clear error messages with `@compileError`.
- The C ABI boundary (`@cImport`, `extern`) is where ownership rules stop being enforced. Document who frees what.
- The language is still moving: pin the compiler version in the repo and say which one the code targets.

## Local gate
- `zig build test` on the touched modules, `zig fmt --check .` for style, and at least one run in `ReleaseSafe` — a bug hidden by debug-mode zeroing shows up there.
