---
paths:
  - "**/*.swift"
  - "**/Package.swift"
---
# Swift

## Navigation
- Map a file: `rg -nE '^\s*(public |private |internal |final |@)?(class|struct|enum|protocol|extension|func|var|let) ' Sources/Thing.swift`.
- NEVER read `.build/`, `DerivedData/`, `Pods/`, `*.xcodeproj/project.pbxproj` (it is generated and merge-hostile).

## Optionals and value semantics
- Force-unwrap (`!`) and `try!` are assertions. In a shipped app they are crashes; use `guard let ... else` with a real fallback.
- `struct` is the default; `class` when identity or shared mutation is genuinely needed. A `struct` captured in a closure is copied, which is usually what you want and occasionally a surprise.
- `[weak self]` in any escaping closure that the object owns, then `guard let self else { return }` — a strong capture in a stored closure is a retain cycle, and the object never deallocates.

## Concurrency
- UI work is on `@MainActor`. Touching UIKit/SwiftUI from a background task is a crash, sometimes only on a slower device.
- `async let` starts work immediately; a `Task {}` that is never awaited and never cancelled keeps running after the view is gone. Store it and cancel in `onDisappear`/`deinit`.
- Swift 6 strict concurrency: a type crossing an actor boundary must be `Sendable`. Silencing it with `@unchecked Sendable` is a promise you are making by hand — write the reason next to it.
- Never block the main thread on a semaphore waiting for an async call. That is a deadlock on the actor you just blocked.

## Errors
- `throws` with a typed error enum; `try?` discards the reason and turns a failure into `nil`, which the caller reads as "empty".

## Tests
- XCTest/Swift Testing; async tests await instead of sleeping. An `XCTestExpectation` with a 10s timeout is a future CI flake.
- A test that never ran red proves nothing.

## Local gate
- `swift build && swift test` (or the scheme's `xcodebuild test`), plus `swiftformat`/`swiftlint` if the repo pins them.
