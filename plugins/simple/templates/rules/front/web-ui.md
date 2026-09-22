---
paths:
  - "**/*.css"
  - "**/*.scss"
  - "**/*.html"
  - "**/tailwind.config.*"
  - "**/locales/**"
  - "**/i18n/**"
---
# UI: text, styling, accessibility

Framework-agnostic. These are the rules that get a front-end diff sent back regardless of the framework.

## Text
- **Every user-visible string goes through i18n** — including error messages, empty states, button labels, `aria-label`s and toast text. A hardcoded string in a prototype is found six months later by a translator, not by you.
- A new key is added to **every** locale the project ships. A missing key either renders the key name or falls back silently to another language; both look broken.
- Locale files are huge. Find the key with `rg -n '"the.key"' path/to/locale.json` and edit that line — never open the whole file.
- Plurals and dates go through the i18n library's own formatting (`Intl`), never string concatenation: "1 items" and a US date in a German UI are the same class of bug.
- Text expands. German is ~30% longer than English; a fixed-width button designed around the English string breaks.

## Styling
- Use the design system's **semantic tokens** (`primary`, `surface`, `error`, `muted`), never a raw palette value. A raw colour bypasses dark mode and the brand, and it is the single most common review rejection on front-end diffs.
- Check whether the component already exists before writing a new one. A near-duplicate is a defect, not a feature.
- Spacing, radius and typography come from the scale. A one-off `margin-top: 13px` is how a design system dies.
- Dark mode is tested, not assumed — including images, shadows, and anything with a hardcoded white background.

## Accessibility (non-negotiable, and cheap if done while writing)
- Every interactive element is a real control: a `div` with a click handler is invisible to keyboard and screen reader. `button` for actions, `a[href]` for navigation.
- Every input has a label; an icon-only button has an accessible name.
- Focus is visible, focus order follows reading order, and a modal traps focus and returns it on close.
- Colour is never the only signal (error states need text or an icon), and contrast meets 4.5:1 for body text.
- Images have `alt` — empty `alt=""` for decorative ones, which is a decision, not an omission.

## States and forms
- Loading, empty and error states exist for every data-driven view. A view that only renders the happy path renders nothing when it matters.
- Validation errors appear next to the field, in the user's language, and the field is announced to assistive technology.
- A destructive action asks for confirmation and names what it will destroy.

## Local gate
- The app's `typecheck` and lint with real output, plus a manual pass at keyboard-only navigation for anything interactive.
