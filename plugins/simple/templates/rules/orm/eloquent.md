---
paths:
  - "**/app/Models/**"
  - "**/database/migrations/**"
  - "**/app/Http/Controllers/**"
---
# Eloquent (Laravel)

## N+1 is the default and Laravel will tell you if you let it
- `Model::all()` followed by `$item->relation->field` in a Blade loop is one query per row. `with('relation')` it.
- Turn on `Model::preventLazyLoading()` in non-production environments (`AppServiceProvider`): it turns every accidental N+1 into an exception during development instead of a slow endpoint in production.
- `withCount()` instead of `count()` on a relation inside a loop. `chunk()`/`cursor()` instead of `all()` for anything that can grow — `all()` on a large table is an out-of-memory error.

## Mass assignment and exposure
- `$fillable` is a whitelist. `$guarded = []` plus `$request->all()` lets a user set `is_admin`, `role` or `account_id` by adding a field to the form.
- `$hidden` for tokens and password hashes, or a resource class that names what goes out. A model serialised directly to JSON exposes every column added later.
- Validation happens in a Form Request before the model is touched, and authorisation in a Policy — a controller that checks neither is the standard Laravel vulnerability.

## Queries and scopes
- Global scopes (soft deletes, tenancy) apply silently and are removed silently by `withoutGlobalScope`/`withTrashed`. A unique index must account for soft-deleted rows.
- `first()` returns `null`, `firstOrFail()` throws a 404-mapped exception, `find($id)` with a wrong-typed id returns null rather than erroring.
- `whereRaw`/`orderByRaw` take bindings. Interpolating a request value — especially a sort column — is an injection; whitelist the column names.
- `update()` on a query builder does not fire model events or touch `updated_at`; `save()` on the model does. Both are correct, in different places.

## Transactions and jobs
- `DB::transaction(fn () => ...)` retries on deadlock if you give it a retry count; anything inside must be safe to run twice.
- **Dispatch jobs with `afterCommit`** (or the queue config flag), or the worker picks the job up before the row is committed and reports "not found".
- Jobs are retried: every job is idempotent and takes ids, not serialised models with stale state.

## Migrations
- Additive against a live database; `down()` written or explicitly refused. A `dropColumn` on some engines rebuilds the whole table.
- `php artisan migrate:fresh` is a development command. It drops everything.

## Tests
- Feature tests against the real engine with `RefreshDatabase`. SQLite in memory is fast and does not enforce the same constraints — it is fine for unit tests, not for anything about the database.
