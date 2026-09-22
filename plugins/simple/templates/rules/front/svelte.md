---
paths:
  - "**/*.svelte"
  - "**/svelte.config.*"
  - "**/+page.*"
  - "**/+layout.*"
---
# Svelte / SvelteKit

The language rules are in `lang/typescript`; cross-framework UI rules are in `front/web-ui`.

## Reactivity
- Svelte 5 runes (`$state`, `$derived`, `$effect`) and Svelte 4 `$:` do not mix in one component. Know which version the project is on before writing a line — `rg -n '"svelte"' package.json`.
- **Assignment is what triggers an update.** `arr.push(x)` updates nothing; `arr = [...arr, x]` does. Same for `Map`/`Set` mutation outside `$state`.
- `$derived` is pure. Side effects go in `$effect`, and an `$effect` that writes the state it reads is an infinite loop.
- A store subscribed with `$store` in the template is auto-unsubscribed; a manual `.subscribe()` is not.

## SvelteKit server/client boundary
- **`+page.server.ts` runs only on the server; `+page.ts` runs on both.** A secret, a database call or a private env import in the universal file ships to the browser.
- `$env/static/private` and `$env/dynamic/private` fail the build if imported from client code — that error is the guard working, not an obstacle to route around.
- `load` runs on navigation as well as on the first request; anything it does must be idempotent and cheap.
- Form actions are public endpoints: authorise inside the action. Progressive enhancement (`use:enhance`) means the form also works without JS — the server must validate either way.
- Module-level state on the server is shared by every request. Per-user state belongs in `locals`, cookies or the load return.

## Components
- Props are declared (`$props()` / `export let`) with types; a component that mutates a prop object mutates the parent's data.
- `{#each}` needs a keyed block (`{#each items as item (item.id)}`) or state follows the position instead of the item.
- `{@html}` is unescaped: sanitise or do not use it.

## Local gate
- `svelte-check --threshold error` (or the project's `check` script) and the build, with real output, plus the touched tests.
