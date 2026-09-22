---
paths:
  - "**/*.vue"
  - "**/nuxt.config.*"
  - "**/vite.config.*"
---
# Vue / Nuxt

The language rules are in `lang/typescript`; cross-framework UI rules are in `front/web-ui`.

## Reactivity, where it actually breaks
- **Destructuring a reactive object loses reactivity.** `const { a } = props` gives you a snapshot; use `toRefs`/`toRef`, or read `props.a` at the point of use.
- `ref` unwraps in templates, not in plain JS objects. A `ref` inside a `reactive` is unwrapped; a `ref` inside an array is not.
- `watch` on a reactive source fires after the change; `watchEffect` also runs immediately and tracks whatever it reads — including things you did not intend to depend on.
- A computed property with a side effect runs at unpredictable times and sometimes twice. Computeds are pure.

## SSR and hydration (Nuxt)
- Anything touching `window`, `document` or `localStorage` runs on the server too. Guard it (`import.meta.client`, `onMounted`), or the build breaks the moment the page is prerendered.
- **A hydration mismatch is a real bug**, not a warning to mute: a random value, a date formatted in the server's timezone, or state read from the browser produces different HTML on the two sides.
- State that must not leak between users never goes in a module-level variable: on the server that module is shared by every request. `useState` exists for exactly this.
- `useAsyncData`/`useFetch` need a stable, explicit key, and every variable the request depends on must be in the key or in `watch`.
- A 4xx is a **server answer**, not a network failure. Classifying it as offline shows the wrong empty state.

## Nuxt layers and auto-imports
- In a monorepo with a shared base layer, a file opened directly from the base reports `Cannot find name '<composable>'` — the base has no tsconfig of its own. That is a false positive: navigate from the consuming app.
- Auto-imports only resolve in an app with a generated `.nuxt/`. Run the project's prepare task before believing a "not found".
- **`.vue` files have no reliable SFC language server**: the app's `typecheck` script is the proof, not the editor.

## Components
- `defineProps` with types, `defineEmits` for every event. A component that mutates a prop is a defect — emit and let the owner change it.
- `v-for` with a stable `:key` that is not the index; with `v-if` on the same element, the `v-if` wins in Vue 3 and the loop variable is not in scope.
- Check whether the design system already has the component before writing a near-duplicate.

## Local gate
- `bun run typecheck` (or `npm run typecheck`) on the app you touched, with real output, plus the lint script.
