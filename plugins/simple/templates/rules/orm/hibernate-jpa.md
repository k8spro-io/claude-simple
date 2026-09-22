---
paths:
  - "**/entity/**/*.java"
  - "**/entities/**/*.java"
  - "**/domain/**/*.java"
  - "**/repository/**/*.java"
  - "**/*Entity.java"
  - "**/*Repository.java"
---
# Hibernate / JPA / Spring Data

## N+1 is the default, and it is invisible in development
- Every `@ManyToOne`/`@OneToOne` is **EAGER by default** — set `fetch = FetchType.LAZY` on all of them. Collections are lazy already.
- Fetch what you need explicitly: `@EntityGraph` on the repository method, or a `join fetch` query. `findAll()` followed by a loop that touches an association is one query per row.
- `join fetch` on two collections at once produces a cartesian product. One collection per query, or `@BatchSize`.
- Turn on `spring.jpa.properties.hibernate.generate_statistics` (or a query counter in tests) when a list endpoint gets slow — counting queries is faster than guessing.

## The session boundary
- `LazyInitializationException` means the entity escaped the transaction. The fix is to fetch what the caller needs **inside** the transaction and return a DTO — not `open-in-view` (which hides the problem and holds a connection for the whole request; turn it off).
- **Entities returned from a controller serialise the whole graph**, trigger lazy loads during serialisation, and leak fields nobody intended to expose. Map to a DTO/record at the boundary.
- A managed entity is written back at flush **even without a `save()` call**: dirty checking means an accidental setter inside a transaction is an UPDATE. That is also why `@Transactional(readOnly = true)` on reads is worth it.

## Transactions
- **`@Transactional` on a method called from the same bean does nothing** — the proxy is bypassed and there is no transaction, with no error. The call must cross a bean boundary.
- Rollback happens on `RuntimeException` only; a checked exception commits unless `rollbackFor` says otherwise.
- Never call an external service inside a transaction: the connection is held for the duration of someone else's outage.

## Equality and identity
- `equals`/`hashCode` on a generated id break the moment an entity is put in a `Set` before it is persisted (the id is null, then changes). Use a business key, or do not override them at all.
- `@Data` from Lombok on an entity generates both, plus a `toString` that walks lazy associations — that is an accidental N+1 inside your logging.

## Schema
- `ddl-auto` is `validate` in every environment that is not a developer laptop. `update` in production is an unreviewed migration; `create-drop` is data loss.
- Schema changes go through Flyway/Liquibase, additively. See the `db/sql` rule.

## Tests
- `@DataJpaTest` with **Testcontainers**, not H2: H2 accepts SQL your database rejects, enforces different constraint semantics, and hides dialect-specific bugs.
- A repository test that passes with the fix reverted is not a test. Assert the number of queries when the fix was about N+1.
