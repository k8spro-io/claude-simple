# The rule catalogue

Rules live in your project at `.claude/rules/`, one file per pack, installed flat as
`<category>-<name>.md`. Each file carries a `paths:` glob list in its frontmatter and **loads itself only when a tool
touches a matching path** — so a repository with forty packs installed still pays nothing for them until the moment
one is relevant. That is the whole reason the language, framework and ORM knowledge lives here instead of in the
always-on instruction file.

`/simple:setup --rules` installs **all** of them, and that is deliberate: there is no detection step to get wrong,
and a pack that does not match this repository never loads, so it never costs a token. If you would rather not carry
49 files, delete the ones you will never need — that is a taste decision about your diff, not a cost decision.

## Languages — `lang/`

| Pack | Covers | Belongs in a repo with |
|---|---|---|
| `go` | errors and sentinels, context and transactions, the fail-open authorization shape, tests, the local gate | `go.mod` |
| `java` | N+1 and the session boundary, `@Transactional` self-invocation, DI, H2-vs-Testcontainers, the Maven/Gradle gate | `pom.xml`, `build.gradle` |
| `kotlin` | platform types, coroutines (`GlobalScope`, cancellation as an exception), data classes, MockK | `.kt` files |
| `python` | mutable defaults, "an exception is not an empty result", typing, the blocked event loop, pytest mocks | `pyproject.toml`, `requirements*.txt`, `.py` files |
| `typescript` | assertions vs validation, floating promises, `Promise.all` bounds, Node config and ESM/CJS | `.ts` files, `tsconfig.json` |
| `rust` | error types, `MutexGuard` across `.await`, cancellation, `unsafe` review, clippy as the gate | `Cargo.toml` |
| `php` | `strict_types`, `===`, parameterised queries, output escaping, Laravel/Symfony notes, PHPStan | `composer.json`, `.php` files |
| `ruby` | nil handling, monkey-patching, Rails callbacks and jobs, `update_column` vs `save` | `Gemfile`, `.rb` files |
| `csharp` | `async void`, `.Result` deadlocks, DI lifetimes, `IEnumerable` laziness, nullable | `.csproj`, `.cs` files |
| `elixir` | supervision choices, `GenServer` serialisation, `with` error handling, atom-table leaks | `mix.exs` |
| `scala` | `Option.get`, implicits, effect systems, collection complexity | `build.sbt`, `.scala` files |
| `cpp` | ownership, iterator/reference invalidation, undefined behaviour, sanitizers | `CMakeLists.txt`, `.cpp` files |
| `dart-flutter` | work in `build`, `BuildContext` across async gaps, disposal, generated files | `pubspec.yaml` |
| `swift` | force-unwraps, retain cycles, `@MainActor`, `Sendable`, cancellation | `Package.swift`, `.swift` files |
| `zig` | allocator discipline, `errdefer`, `catch unreachable`, `std.testing.allocator` leak detection | `build.zig` |
| `clojure` | laziness across resource scopes, `swap!` retries, namespaced keys, `ex-info` | `deps.edn`, `project.clj` |
| `shell` | `set -euo pipefail`, quoting, destructive-step confirmation, ShellCheck | `.sh` files |

## Front-end — `front/`

| Pack | Covers | Belongs in a repo with |
|---|---|---|
| `react` | derived state, effect cleanup, list keys, memoisation order, Next.js server/client and caching | `react`/`next` in `package.json` |
| `vue-nuxt` | reactivity loss on destructuring, hydration mismatches, server-shared module state, layers | `vue`/`nuxt` in `package.json` |
| `angular` | subscription leaks, `switchMap` vs `concatMap`, `OnPush`, reactive forms, DI scope | `@angular/core` |
| `svelte` | runes vs `$:`, assignment-triggers-update, the `+page.server` boundary, form actions | `svelte` |
| `react-native` | no DOM, platform differences, list performance, secure storage, native-vs-JS releases | `react-native`/`expo` |
| `web-ui` | i18n for every string, semantic tokens, accessibility, loading/empty/error states | any front-end framework, or a stylesheet |

## ORMs and data mappers — `orm/`

| Pack | The traps it carries | Belongs in a repo with |
|---|---|---|
| `gorm` | handle discipline in transactions, `Updates` skipping zero values, soft deletes, the `DryRun` false-green test | `gorm.io` |
| `ent` | generated code boundaries, explicit eager loading, `Only` vs `First`, privacy rules in tests | `entgo.io` |
| `sqlc` | the SQL file as source of truth, nullable columns, `WithTx`, schema drift | `sqlc.yaml` |
| `hibernate-jpa` | EAGER by default, `LazyInitializationException`, dirty checking, proxy self-invocation, H2 | `hibernate`, `spring-boot-starter-data-jpa` |
| `sqlalchemy` | session lifetime, expiry after commit, `selectinload`, Alembic autogenerate as a draft | `sqlalchemy`, `alembic` |
| `django-orm` | queryset evaluation, `select_related`/`prefetch_related`, atomic blocks, signals | `django` |
| `prisma` | one client per process, interactive transaction timeouts, `db push` vs `migrate` | `prisma` |
| `drizzle` | `and()` in `where`, nullable left joins, `tx` vs `db`, `generate` vs `push` | `drizzle-orm` |
| `typeorm` | `synchronize: true`, `undefined` in a `where` silently dropping the filter, `save` vs `update` | `typeorm` |
| `mongoose` | validators on update, indexes vs `unique: true`, `.lean()`, `populate` as an N+1 | `mongoose` |
| `eloquent` | `preventLazyLoading`, mass assignment, global scopes, `afterCommit` for jobs | `laravel/framework` |
| `doctrine` | one flush per request, identity map growth, DQL projections, schema-update-as-migration | `doctrine/orm` |
| `activerecord` | `strict_loading`, validations vs constraints, `after_commit`, concurrent index creation | `rails`, `activerecord` |
| `efcore` | scoped `DbContext`, client-side evaluation, `AsNoTracking`, the in-memory provider | `EntityFrameworkCore` |
| `rust-sql` | choosing sqlx/Diesel/SeaORM, the `.sqlx` offline cache, blocking Diesel in async | `sqlx`, `diesel`, `sea-orm` |
| `ecto` | constraints behind changeset validations, `Ecto.Multi`, sandbox tests, concurrent indexes | `ecto` |

## Databases — `db/`

| Pack | Covers | Belongs in a repo with |
|---|---|---|
| `sql` | the additive-delta rule, three-deploy column addition, bound parameters, keyset pagination, transaction discipline | migrations or `.sql` files, or any ORM |
| `postgres` | lock behaviour during `ALTER`, `CONCURRENTLY`, `timestamptz`, `NOT IN` with NULL, pooling | a Postgres driver or image |
| `mysql-tidb` | `utf8mb4`, collation, online DDL algorithms; TiDB's async DDL, absent FKs, non-monotonic ids | a MySQL/TiDB driver or image |
| `mongodb` | embed-vs-reference, write concern, index shape, unindexed sorts, application-level schema change | a MongoDB driver or image |
| `redis` | TTLs, rebuildable values, key scoping (the tenant bug), locks, `KEYS` vs `SCAN`, stampedes | a Redis client or image |

## Infrastructure — `infra/`

| Pack | Covers | Belongs in a repo with |
|---|---|---|
| `ci` | same commit for test/build/deploy, pinned actions, fork PR credentials, rollback | `.github/workflows`, `.gitlab-ci.yml`, `Jenkinsfile` |
| `docker` | layer ordering, `.dockerignore`, non-root, PID 1 and signals, build-arg secrets | `Dockerfile`, compose files |
| `kubernetes` | digests not tags, requests/limits, liveness vs readiness, ConfigMap restarts, what never to delete | `k8s/`, `helm/`, `kustomization.yaml` |
| `terraform` | reading the plan, state as a credential, `for_each` vs `count`, `prevent_destroy` | `.tf` files |
| `build` | one named target per command, no gate that boots its own environment, per-tool gotchas | `Taskfile.yml`, `Makefile`, `justfile` |

## Writing your own

The format is a frontmatter `paths:` list and Markdown below it. Two things decide whether a rule is worth its file:

1. **It is something a competent colleague would get wrong.** "Use meaningful names" teaches nothing; "a `@Transactional` method called from the same bean opens no transaction and reports no error" does.
2. **The glob matches your layout.** A glob that matches nothing loads nothing, silently, forever. Check it with
   `rg --files -g '<your glob>' | head`.

Rules that are ignored are worse than no rules: they teach the model that the rule files are optional. Delete the
ones you disagree with.
