---
paths:
  - "**/*.dart"
  - "**/pubspec.yaml"
---
# Dart / Flutter

## Navigation
- Map a file: `rg -nE '^\s*(class|Widget build|Future<|void |final |@override)' lib/feature/thing.dart`.
- NEVER read `.dart_tool/`, `build/`, `ios/Pods/`, generated `*.g.dart` / `*.freezed.dart` — edit the source and re-run the generator.

## Widgets
- `const` constructors wherever possible: they are the difference between rebuilding a subtree and reusing it.
- **Do not do work in `build`.** It runs on every frame-triggering change; a network call or a heavy computation there is a jank machine and sometimes an infinite loop.
- `setState` after `dispose` throws. Guard with `if (!mounted) return;` after every `await` in a `State`.
- **Never use a `BuildContext` across an async gap** without checking `context.mounted` — the classic "Looking up a deactivated widget's ancestor" crash.
- Controllers, streams, animations and focus nodes are disposed in `dispose()`. A leaked `StreamSubscription` keeps the whole page alive.

## State and data
- Pick the project's state solution and stay in it (Riverpod, Bloc, Provider). Two solutions in one app means nobody can tell where the truth is.
- Keep UI state and domain state apart: a model that knows about `BuildContext` cannot be tested.
- Every user-visible string goes through the project's localisation (`.arb` files), including error messages.

## Async
- `Future` errors that are not awaited become unhandled zone errors — they reach the crash reporter, not your `try/catch`.
- Platform channels can fail: handle `PlatformException`, and never assume a plugin works on both platforms without checking.

## Tests
- Widget tests with `pumpAndSettle` for animations; golden tests only if the CI runs the same platform, otherwise they flake on font rendering.
- A test that never ran red proves nothing.

## Local gate
- `dart format --set-exit-if-changed .` , `flutter analyze` (zero issues, not "only warnings") and `flutter test` on the touched paths.
