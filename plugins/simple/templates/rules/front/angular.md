---
paths:
  - "**/*.component.ts"
  - "**/*.service.ts"
  - "**/*.module.ts"
  - "**/angular.json"
---
# Angular

The language rules are in `lang/typescript`; cross-framework UI rules are in `front/web-ui`.

## Subscriptions leak by default
- **Every manual `.subscribe()` needs an unsubscribe**: `takeUntilDestroyed()`, a `Subject` closed in `ngOnDestroy`, or the `async` pipe (which unsubscribes for you — prefer it).
- A subscription created inside another subscription is a nested leak and an ordering bug. Compose with `switchMap`/`concatMap`/`mergeMap`, and pick deliberately: `switchMap` cancels the previous request (right for a search box, wrong for a save), `concatMap` keeps order, `mergeMap` does not.
- `shareReplay({ refCount: true })` — without `refCount` the source stays subscribed forever.

## Change detection
- `OnPush` on every component, with signals or immutable inputs. Default change detection re-checks the whole tree on every event.
- A function call in a template (`{{ compute() }}`) runs on every change-detection pass. Use a pure pipe, a signal, or a precomputed field.
- Mutating an array in place does not trigger `OnPush`; replace the reference.
- `ExpressionChangedAfterItHasBeenCheckedError` means state changed during the check — fix the timing, do not paper over it with `detectChanges()`.

## Forms
- Reactive forms for anything with validation; typed forms (`FormGroup<...>`) so a renamed control is a compile error.
- Validation lives in validators, not in the submit handler, and the error messages come from i18n.

## DI and structure
- `providedIn: 'root'` for singletons; providing a service in a component creates one instance *per component instance* — deliberate or a bug, never an accident.
- Standalone components for new code. A shared module that re-exports everything makes the bundle unsplittable.
- HTTP calls live in services, never in components. Interceptors carry auth and error mapping, once.

## Security
- Angular escapes by default; `bypassSecurityTrustHtml` re-opens XSS. Every use needs a reviewed reason and a sanitised source.

## Local gate
- `ng build` (or the project's build), `ng test --watch=false` on the touched specs, and the lint script, with real output.
