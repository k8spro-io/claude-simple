---
paths:
  - "**/*.tsx"
  - "**/*.jsx"
  - "**/metro.config.*"
  - "**/app.config.*"
  - "**/app.json"
---
# React Native / Expo

Read `front/react` first — everything there applies. This is what is different on a device.

Install this pack only in a repository that actually has `react-native` or `expo` in its dependencies. Its globs are
then the ordinary source files of the app — `ios/**` and `android/**` are deliberately **not** in the list, because a
Flutter or Capacitor project has those directories too and would load these rules for nothing.

## There is no DOM, and no forgiving browser
- No `div`, no CSS cascade, no `z-index` across siblings, no percentage height without a parent that has one. Layout is flexbox, in points, per platform.
- Platform differences are the rule: shadows (`elevation` on Android vs `shadow*` on iOS), keyboard avoidance, safe areas, back button behaviour, permission dialogs. A screen tested on one platform is tested on half.
- Anything measured in pixels must respect the device's font scale and density, or it breaks for users with large text.

## Performance on a phone
- `FlatList`/`FlashList` with `keyExtractor` for any list that can grow. A `map` over 500 rows inside a `ScrollView` renders all 500 and drops frames.
- An inline arrow function or object in a list item's props re-renders every row on every parent render.
- Heavy work belongs off the JS thread: animations through `react-native-reanimated` worklets or the native driver, not `setState` per frame.
- Images need explicit dimensions and a cache strategy; a full-resolution photo in a 60pt avatar is a memory spike.

## State that survives the app
- The app is backgrounded, killed and restored at the OS's discretion. Anything the user typed must survive it, and anything in memory must be rebuildable.
- Secrets go in the keychain/keystore (`expo-secure-store`, `react-native-keychain`), never `AsyncStorage`, which is plain text on a rooted device.
- Deep links and notification taps enter the app at an arbitrary screen: every screen must be reachable cold.

## Builds and updates
- A native dependency means a rebuild, not a reload: Expo Go and OTA updates cannot ship native code. Know which changes are JS-only before promising a hotfix.
- Version and build numbers are bumped deliberately; a store build with a duplicate build number is rejected after the CI minutes are spent.

## Local gate
- `tsc --noEmit`, the lint script, the touched tests, and a run on **both** platforms for anything touching layout, permissions or navigation.
