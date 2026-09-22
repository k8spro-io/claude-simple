---
paths:
  - "**/*.php"
  - "**/composer.json"
---
# PHP

## Navigation
- Map a class: `rg -nE '^\s*(public|protected|private|abstract|final|class|interface|trait|function) ' src/Thing.php`.
- NEVER read `vendor/`, `storage/logs/`, `bootstrap/cache/`, `public/build/`.

## Types and strictness
- `declare(strict_types=1);` at the top of every file. Without it PHP coerces `"abc"` to `0` and the bug reaches the database.
- Type every parameter, property and return. `mixed` is the last resort, and it is a review question.
- `==` compares after juggling (`"1e3" == "1000"` is true). Use `===` everywhere; `in_array` needs its third argument `true`.
- Null-safe operator `?->` short-circuits the whole chain — that includes the method call you expected to run for its side effect.

## Errors
- Throw typed exceptions; do not return `false` for failure and a value for success — the caller will not check.
- `@` suppression hides the error and keeps the broken value. Never.
- An exception is not an empty result: a `catch` that returns `[]` reports "nothing found" for a failed query.

## Security (the defaults are not safe)
- Every query is parameterised. String interpolation into SQL is an injection, including in an `ORDER BY` built from a request field — whitelist the column names instead.
- Escape on output (`htmlspecialchars`, or the template engine's auto-escaping). A "raw" filter in a template needs a reason.
- `unserialize()` on user input is remote code execution. Use `json_decode`.
- Uploaded files are never trusted by extension, never written inside the web root, and never executed.

## Framework notes
- Laravel: mass assignment is guarded by `$fillable`, validation happens in a Form Request, and business logic does not live in the controller. Queue jobs must be idempotent — they are retried.
- Symfony: services are constructor-injected and autowired; the container is not a service locator.

## Tests
- PHPUnit/Pest against a real database for anything the ORM touches (see the `orm/` rule for your ORM). An in-memory SQLite proves SQLite.
- A test that never ran red proves nothing.

## Local gate
- `composer test` (or `vendor/bin/phpunit`), `vendor/bin/phpstan analyse` at the level the project pins, and the project's formatter (`pint`, `php-cs-fixer`). Never lower the PHPStan level to make a change pass.
