// The engine as `session.start` binds it from `$` (hostOf in register.tsx).
// Every lane, timer and handler reaches Claude Code through this, so the
// logic beside it is plain code a test drives with a fake host.

import type {
  CommandSpec,
  PaneCloseArgs,
  PaneOpenArgs,
  ProcessRunInit,
  ProcessRunResult,
  SessionUsage,
  SessionUsageArgs,
  Settings,
  Timer,
  UiOpenResult,
  UiPane,
} from 'claude-code'

export type Host = {
  /** The plugin's folder, the one holding scripts/. */
  root: string
  now: () => Promise<number>
  after: (ms: number, fn: () => void) => Timer
  every: (ms: number, fn: () => void) => Timer
  cwd: () => Promise<string>
  model: () => Promise<string>
  usage: (args?: SessionUsageArgs) => Promise<SessionUsage>
  run: (argv: readonly string[], init?: ProcessRunInit) => Promise<ProcessRunResult>
  /** The STATUSLINE_NERD environment variable. */
  nerdFont: () => Promise<string | undefined>
  /** CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: set, the mod asks GitHub nothing, as Claude Code's own PR badge does. */
  quietNetwork: () => Promise<string | undefined>
  settings: () => Promise<Settings>
  storeGet: (key: string) => Promise<unknown>
  storeSet: (key: string, value: unknown) => Promise<void>
  /** Draws the plugin's render sites again. */
  invalidate: () => void
  toast: (text: string, timeoutMs?: number) => void
  /** A line in the debug log only. */
  log: (text: string) => void
  openPane: (pane: PaneOpenArgs) => Promise<UiOpenResult>
  closePane: (pane: PaneCloseArgs) => Promise<void>
  panes: () => Promise<readonly UiPane[]>
  registerCommand: (spec: CommandSpec) => Promise<unknown>
  /** Runs a slash command as if the person typed it (queued until the turn ends while Claude works). */
  runCommand: (command: string) => Promise<unknown>
  /** Puts text on the clipboard of the terminal the person is at. */
  copy: (text: string) => Promise<unknown>
}
