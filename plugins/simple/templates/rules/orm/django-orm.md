---
paths:
  - "**/models.py"
  - "**/views.py"
  - "**/admin.py"
  - "**/serializers.py"
  - "**/migrations/**/*.py"
---
# Django ORM

## Querysets are lazy, and that is where the cost hides
- A queryset is evaluated when it is iterated, sliced with a step, `len()`-ed, or `bool()`-ed. Two evaluations of the same queryset are two queries; `list()` it once if you need it twice.
- **`select_related` (joins, for FK/one-to-one) and `prefetch_related` (second query, for M2M/reverse FK)** are how you kill the N+1. A template that walks `obj.related.field` in a loop is one query per row and nobody sees it until production.
- `.only()`/`.defer()` save bandwidth and create a *new* N+1 when a deferred field is touched later.
- `.count()` is a COUNT query; `len(qs)` fetches every row. Inside a template, `{% if qs %}` evaluates the whole queryset.
- `.exists()` for existence, `.update()` for a mass change — but `.update()` does not call `save()`, does not send signals and does not touch `auto_now` fields.

## Correctness
- `get()` raises `DoesNotExist` **and** `MultipleObjectsReturned`; `filter().first()` returns `None`. Choose the failure you want to handle.
- `get_or_create` / `update_or_create` are not atomic without a unique constraint — under concurrency they create duplicates. The constraint in the database is the real guarantee.
- Race-free counters use `F()` expressions (`F("stock") - 1`), never read-modify-write in Python.
- `transaction.atomic()` blocks: a caught `IntegrityError` **inside** an atomic block leaves the transaction broken — catch it outside, or wrap the failing statement in its own nested atomic.
- Signals (`post_save`) create invisible action at a distance and run inside the caller's transaction. Prefer an explicit service function; if a signal must enqueue a job, use `transaction.on_commit`.

## Migrations
- Every model change has a migration, committed with the change. `makemigrations --check --dry-run` in CI catches the one that was forgotten.
- Adding a NOT NULL column with a default rewrites the table on some engines. Nullable → backfill in batches → tighten, across deploys.
- `RunPython` needs a reverse function or an explicit `noop`, and it must use the historical model (`apps.get_model`), never the imported one.

## Security defaults you can still break
- Templates auto-escape; `|safe` and `mark_safe` re-open XSS.
- `.extra()` and `.raw()` take parameters — string interpolation there is SQL injection.
- A `ModelForm`/serializer with `fields = "__all__"` exposes every field, including the ones added next month.

## Tests
- `pytest-django` against the real engine. `assertNumQueries` is the only honest regression test for an N+1 fix.
