---
paths:
  - "**/*.jsx"
  - "**/*.tsx"
  - "**/next.config.*"
---
# React / Next.js

The language rules are in `lang/typescript`; cross-framework UI rules are in `front/web-ui`. This one is React itself.

## Rendering and state
- **Derived state is computed during render, not stored.** A `useState` that a `useEffect` keeps in sync with a prop is a bug with extra steps: it renders once with the stale value first.
- `useEffect` is for synchronising with something *outside* React (subscription, timer, imperative DOM). Fetching on mount, transforming props, or "running this when that changes" are usually not effects.
- Every effect that starts something returns a cleanup. A fetch without an abort, or a subscription without an unsubscribe, sets state on an unmounted component and leaks.
- Missing dependencies in an effect capture stale values; silencing the lint rule hides the staleness instead of fixing it.
- **Keys must be stable and identity-bearing.** `key={index}` on a reorderable or filterable list moves the wrong state onto the wrong row — the most common "the form cleared itself" bug.

## Performance, in this order
1. Do not create work: derive cheaply, split the component, lift the expensive part out.
2. Then memoise: `useMemo`/`useCallback`/`memo`, each with a reason. A `useCallback` whose dependencies change every render costs more than it saves.
3. A new object or array literal in JSX props breaks every `memo` below it.

## Next.js
- **Server Component by default; `"use client"` is a decision.** It pulls the component and its imports into the bundle, and everything below it becomes client too.
- A secret read in a Server Component is safe; the same read in a client component ships the secret to the browser. `NEXT_PUBLIC_*` is public — that is what the prefix means.
- Server Actions are public HTTP endpoints. Authenticate and authorise inside the action; the fact that only your UI calls it is not a control.
- Caching is the source of most "it does not update" reports: `fetch` caching, `revalidate`, `dynamic`, and the router cache are four different layers. State which one you rely on, and use `revalidatePath`/`revalidateTag` after a mutation.
- `useSearchParams` opts a route into client rendering; wrap it in `Suspense` or the whole page becomes dynamic.

## Data fetching
- A 4xx is a **server answer**, not a network failure. Rendering the offline state for a rejected request tells the user the wrong thing.
- Every query key includes every variable the request depends on, or two different requests share one cached answer.
- Show the three states — loading, empty, error — explicitly. A component that only renders the happy path renders nothing when it matters.

## Tests
- React Testing Library: assert what the user sees, not the component's internals. Queries by role and label, not by test id, wherever the accessible name exists.
- A test that never ran red proves nothing.

## Local gate
- `tsc --noEmit` (or the app's `typecheck`), the lint script, and the touched tests, with real output.
