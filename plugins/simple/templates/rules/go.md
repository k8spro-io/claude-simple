---
paths:
  - "**/*.go"
  - "**/go.mod"
  - "**/go.sum"
---
# Go

## Navigation, before opening a file
- Start with a glob-scoped `grep`, then `sed -n` on the region (skill `code-navigation`). NEVER read a whole file.
- To map a large `.go`: `rg -nE '^(func|type) ' <file>`. Do **not** use the LSP's `documentSymbol` as a map — measured
  at 76% of all LSP output (mean 7.9k chars, peak 25k) for something `rg` does for half the price.
- The `LSP` tool (gopls) is for when you already have a **position**: `goToDefinition`, `findReferences`,
  `incomingCalls`, `hover` (51–413 chars each). It replaces your second grep; it is never added on top of it.
  `workspaceSymbol` only for identifiers of 12+ characters.
- The tool is deferred, and `ToolSearch("select:LSP")` costs a whole turn: emit it in the **same block** as the first
  `Bash`/`Grep` of the session, never alone.

## Errors
- Package sentinel: `var ErrThing = errors.New("package: ...")`. Wrap with `fmt.Errorf("...: %w", err)`, compare with
  `errors.Is`. Never compare error strings.
- **An error is not an empty result.** `if err != nil { treat as "none" }` turns a dropped connection into "no owner",
  "no mandate", "no permission" — and then writes something wrong. Separate "genuinely absent" (`ErrNotFound`) from
  "the read failed", and stop on the second.

## Context and transactions
- `ctx context.Context` is the first parameter of every service and repository method. Handlers pass the request
  context, never `context.Background()`.
- **Inside a transaction, reads go through the transaction.** A lookup that takes its own connection from the pool
  while a transaction is open is a second checkout and deadlocks under load. `...Tx` variants must take the handle and
  fail loudly on a nil one rather than silently falling back to the pool.
- Anything that must hold across two writes belongs in one transaction, and a partial failure must roll back — never
  leave a half-written ledger.

## Authorization — the fail-open shape to watch for
- An `authorize*` / `require*` helper returns the **raw error** and NEVER writes the HTTP response. Writing the
  response inside the helper means returning what the write returned — `nil` on success — so the caller reads
  "authorized" and stores the data *after* the 403.
- The write belongs in the handler: `if err := h.authorizeX(...); err != nil { return writeAuthzError(c, err) }`.
- A helper that only masks a field is not a gate. Do not name it `authorize*`.
- A gate test asserts the response **body** and that nothing changed in the database. Asserting only the status code
  lets the fail-open shape through.

## Tests
- A test that never ran red proves nothing. Revert the change, watch it fail, reapply.
- Tests that need a real database read the DSN from the environment and `t.Skipf` when it is absent — never `t.Fatal`,
  or the suite is red for everyone without a database.
- **GORM `DryRun` trap:** under DryRun the driver skips `Scan`, so `Take`/`First` return a **nil** error and a zero
  struct, never `ErrRecordNotFound`. A "not found" test written that way passes with the fix reverted. Inject the
  failure with a callback (`Before("gorm:query")`) instead. DryRun is still the right tool for proving *which SQL was
  issued on which handle*.

## Local gate
- `go build ./... && go vet ./... && go test ./...` on what you touched, plus `gofmt -l` clean.
- Integration/e2e files behind a build tag (`//go:build e2e`) are outside `go test ./...` — run them explicitly.
