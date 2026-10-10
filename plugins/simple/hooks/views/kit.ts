// Shared drawing helpers of the two pane views, Work and Session: number and
// time formats, the status marks, and a row layout that keeps every line inside
// the pane's width. The surface's element constructors come in as plain
// arguments; nothing here touches the engine, so the views and their tests
// share it.

import type { BoxProps, ButtonProps, Color, ElementConstructor, RenderElement, RenderNode, TextProps } from 'claude-code'

import type { Check, CheckOutcome, MergeState, PullRequest, ReviewState } from '../model'

/** The element constructors a surface hands out (`$.ui.resolve(e)`), as the views take them. */
export type Kit = {
  Box: ElementConstructor<BoxProps>
  Text: ElementConstructor<TextProps>
  Button: ElementConstructor<ButtonProps>
}

/** One run of a row: its text, how it is drawn, and how it gives way when the row is too wide. */
export type Part = {
  text: string
  color?: Color
  bold?: boolean
  dim?: boolean
  /** Left out whole when the row does not fit, the highest number first; without one it stays. */
  drop?: number
  /**
   * Marks the part a row cuts with an ellipsis when it is too wide, down to this many cells before any other
   * part is left out, and below that when nothing else can leave; the first one in a row counts.
   */
  min?: number
}

/** A status glyph, the words it stands for, and its color. */
export type Mark = { mark: string; words: string; color: Color }

/** A button the views draw without chrome: the label alone, or `1: label` when it has a hotkey. */
export type ButtonSpec = {
  key: string
  label: string
  /** One digit or one lowercase letter. */
  hotkey?: string
  /** Drawn dim at rest, for a secondary control. */
  dim?: boolean
  onPress: () => void
}

/** The color of section headers. */
export const HEAD: Color = 'claude'
/** The color of what is secondary: counts, ages, hints, empty states. */
export const MUTED: Color = 'inactive'

const DEFAULT_WIDTH = 40
/** The cells a plain Button with a hotkey draws before its label: `1: `. */
export const HOTKEY_CELLS = 3

/** How a pull request's review reads, by `reviewOf`; the words are the long form. */
export const REVIEW_MARKS: Record<ReviewState, Mark> = {
  approved: { mark: '✓', words: 'approved', color: 'success' },
  changes_requested: { mark: '✗', words: 'changes requested', color: 'error' },
  pending: { mark: '○', words: 'review pending', color: 'warning' },
  draft: { mark: '◌', words: 'draft', color: MUTED },
}

/** How a check, or a CI run, ended. */
export const CHECK_MARKS: Record<CheckOutcome, Mark> = {
  passed: { mark: '✓', words: 'passed', color: 'success' },
  failed: { mark: '✗', words: 'failed', color: 'error' },
  pending: { mark: '●', words: 'pending', color: 'warning' },
  skipped: { mark: '–', words: 'skipped', color: MUTED },
}

/** Whether a pull request can merge, in the words the pane uses. */
export const MERGE_WORDS: Record<MergeState, { words: string; color: Color }> = {
  clean: { words: 'ready', color: 'success' },
  behind: { words: 'behind main', color: 'warning' },
  dirty: { words: 'conflicts', color: 'error' },
  blocked: { words: 'blocked', color: 'warning' },
  unstable: { words: 'unstable', color: 'warning' },
  draft: { words: 'draft', color: MUTED },
  unknown: { words: 'unknown', color: MUTED },
}

// ---------------------------------------------------------------- formats

/** The time from `at` to `nowMs` as one short figure: "12s", "3m", "2h", "4d"; "" when it is not known: not a number, or not after the epoch. */
export function ago(nowMs: number, at: number): string {
  const seconds = Math.max(0, Math.floor((nowMs - at) / 1000))

  if (!Number.isFinite(seconds) || !(at > 0)) {
    return ''
  }

  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)

  if (minutes < 1) {
    return `${seconds}s`
  }
  if (hours < 1) {
    return `${minutes}m`
  }

  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}

/** 65 s -> "1m05s", 3725 s -> "1h02m": how long something has run. */
export function clock(ms: number): string {
  const seconds = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)

  if (hours > 0) {
    return `${hours}h${String(minutes).padStart(2, '0')}m`
  }
  if (minutes > 0) {
    return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`
  }

  return `${seconds}s`
}

/** 820 -> "820ms", 1400 -> "1.4s", 12000 -> "12s", 125000 -> "2m05s": how long one call took. */
export function latency(ms: number): string {
  const whole = Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : 0

  if (whole < 1000) {
    return `${whole}ms`
  }

  const tenths = Math.round(whole / 100)

  if (tenths < 100) {
    return `${Math.floor(tenths / 10)}.${tenths % 10}s`
  }

  const seconds = Math.round(whole / 1000)

  return seconds < 60 ? `${seconds}s` : clock(seconds * 1000)
}

/** 1 -> "1 call", 2 -> "2 calls": a regular plural. */
export function count(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/** 0.4213 -> "$0.42". */
export function usd(amount: number): string {
  return `$${(Number.isFinite(amount) ? amount : 0).toFixed(2)}`
}

/** `gauge(50, 4)` is "▰▰▱▱": the nearest cell is filled; a percentage out of range or not a number is clamped. */
export function gauge(pct: number, width: number): string {
  const size = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0
  const filled = Number.isFinite(pct) ? Math.max(0, Math.min(size, Math.round((pct / 100) * size))) : 0

  return `${'▰'.repeat(filled)}${'▱'.repeat(size - filled)}`
}

/** The first `max` of `items`, the rest counted: "alice, bob +2". Blank items are left out. */
export function names(items: readonly string[], max: number): string {
  const all = items.map(clean).filter(item => item !== '')
  const shown = all.slice(0, Math.max(0, max))
  const rest = all.length - shown.length

  return rest > 0 ? `${shown.join(', ')} +${rest}` : shown.join(', ')
}

/** "mcp__docs__search" -> "docs:search": an MCP tool with its server; any other name as it is. */
export function shortTool(name: string): string {
  const match = /^mcp__(.+?)__(.+)$/.exec(name)

  return match === null ? name : `${match[1] ?? ''}:${match[2] ?? ''}`
}

/** "mcp__docs__search" -> "search": an MCP tool without its server, for rows already under it. */
export function bareTool(name: string): string {
  return name.replace(/^mcp__.+?__/, '')
}

// ---------------------------------------------------------------- marks

/** How a pull request's review reads: a draft first, then the decision; null when none is asked for. */
export function reviewOf(pr: Pick<PullRequest, 'isDraft' | 'review'>): Mark | null {
  if (pr.isDraft) {
    return REVIEW_MARKS.draft
  }

  return pr.review === null ? null : REVIEW_MARKS[pr.review]
}

/** The worst outcome of a set of checks: failed, then pending, then passed, then skipped; null when there are none. */
export function worstOutcome(checks: readonly Check[]): CheckOutcome | null {
  for (const outcome of ['failed', 'pending', 'passed', 'skipped'] as const) {
    if (checks.some(check => check.outcome === outcome)) {
      return outcome
    }
  }

  return null
}

// ---------------------------------------------------------------- safe text

// ANSI escape sequences whole (CSI and OSC, in their 7-bit and 8-bit forms), so what they carried does not
// show as stray letters; then the controls, bidi and zero-width marks no row may hold.
const ESCAPES = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u009b[0-?]*[ -/]*[@-~]/g
const BREAKS = /[\t\n\r\v\f\u{2028}\u{2029}]/gu
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u{61c}\u{200b}-\u{200f}\u{202a}-\u{202e}\u{2060}-\u{2069}\u{feff}]/gu

/**
 * Text from outside (a title, a tool's words) made safe to draw: escape sequences and control characters
 * out, line breaks and tabs to spaces. Spaces stay as they are.
 */
export function scrub(text: string): string {
  return text.replace(ESCAPES, '').replace(BREAKS, ' ').replace(UNSAFE, '')
}

/** `scrub`, then runs of whitespace as one space and the ends trimmed: what a title or a name is shown as. */
export function clean(text: string): string {
  return scrub(text).replace(/\s+/g, ' ').trim()
}

// ---------------------------------------------------------------- width

// East Asian wide and fullwidth blocks, and the emoji drawn two cells wide.
const WIDE: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f],
  [0x2705, 0x2705],
  [0x26a1, 0x26a1],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x2b50, 0x2b50],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd],
]

function cellsOf(code: number): number {
  if (code < 0x300) {
    return 1
  }
  if ((code >= 0x300 && code <= 0x36f) || (code >= 0xfe00 && code <= 0xfe0f)) {
    return 0
  }

  return WIDE.some(([from, to]) => code >= from && code <= to) ? 2 : 1
}

/** How many terminal cells `text` takes: wide characters (CJK, emoji) two, combining marks none. */
export function cells(text: string): number {
  let total = 0

  for (const char of text) {
    total += cellsOf(char.codePointAt(0) ?? 0)
  }

  return total
}

/** `text` cut to `room` cells, an ellipsis ending what was cut; "" when there is no room. */
export function cut(text: string, room: number): string {
  if (cells(text) <= room) {
    return text
  }
  if (room < 1) {
    return ''
  }

  let kept = ''
  let used = 0

  for (const char of text) {
    const size = cellsOf(char.codePointAt(0) ?? 0)

    if (used + size > room - 1) {
      break
    }
    kept += char
    used += size
  }

  return `${kept.trimEnd()}…`
}

function flexOf(parts: readonly Part[]): number {
  return parts.findIndex(part => part.min !== undefined)
}

/** The row's width with its flexible part cut down to its minimum. */
function tightest(parts: readonly Part[]): number {
  const flex = flexOf(parts)

  return parts.reduce((sum, part, index) => sum + (index === flex ? Math.min(cells(part.text), part.min ?? 0) : cells(part.text)), 0)
}

/**
 * The parts of a row cut to `width` cells. Parts with a `drop` rank leave first, the highest rank first and
 * the later of two equal ranks first, until the row fits with its flexible part (the first with `min`) at its
 * minimum; that part then takes the room that is left, cut with an ellipsis, below its minimum when nothing
 * else can leave; last, whatever still overflows is cut off at the end. A width that is not a number is no limit.
 */
export function fit(parts: readonly Part[], width: number): Part[] {
  const limit = Number.isNaN(width) ? Number.POSITIVE_INFINITY : width
  let row = parts.filter(part => part.text !== '')

  while (tightest(row) > limit) {
    let out = -1

    for (const [index, part] of row.entries()) {
      if (part.drop !== undefined && (out < 0 || part.drop >= (row[out]?.drop ?? 0))) {
        out = index
      }
    }
    if (out < 0) {
      break
    }
    row = row.filter((_, index) => index !== out)
  }

  const flex = flexOf(row)
  const others = row.reduce((sum, part, index) => sum + (index === flex ? 0 : cells(part.text)), 0)

  row = row
    .map((part, index) => (index === flex ? { ...part, text: cut(part.text, limit - others) } : part))
    .filter(part => part.text !== '')

  const fitted: Part[] = []
  let room = limit

  for (const part of row) {
    if (room <= 0) {
      break
    }

    const size = cells(part.text)

    fitted.push(size <= room ? part : { ...part, text: cut(part.text, room) })
    room -= Math.min(size, room)
  }

  return fitted
}

/**
 * Parts of one row separated by " · ": each but the first non-empty one starts with the separator, or all of
 * them when a head comes before. Without a head, the first part loses its `drop` rank and stays, whichever part
 * comes first: were it to leave, the next would open the row with the separator.
 */
export function dotted(parts: readonly (Part | null)[], hasHead = false): Part[] {
  const kept = parts.filter((part): part is Part => part !== null && part.text !== '')

  return kept.map((part, index) => (index === 0 && !hasHead ? { ...part, drop: undefined } : { ...part, text: ` · ${part.text}` }))
}

// ---------------------------------------------------------------- rows

/** The rows a view is made of, each cut to the pane's width; see `layout`. */
export type Layout = {
  /** Cells across the pane's body: the room every row has. */
  room: number
  /** One row from parts, cut to the room by `fit`; the Text also asks the engine to cut at the edge, should a width be miscounted. */
  line: (parts: readonly Part[]) => RenderElement
  /** A section's title: bold, in the header color, with a muted tail (a count). */
  header: (title: string, tail?: string) => RenderElement
  /** A title inside a section: bold and muted, with a muted tail. */
  subheader: (title: string, tail?: string) => RenderElement
  /** A muted row for what there is none of. */
  empty: (words: string) => RenderElement
  /** Muted text the surface wraps, cut to `chars` characters; `indent` pushes every wrapped row in. */
  wrapped: (text: string, options: { color?: Color; chars: number; indent?: number }) => RenderElement
  /** A button without chrome. */
  button: (spec: ButtonSpec) => RenderElement
  /** A row of parts with a button at its right edge. */
  withButton: (parts: readonly Part[], spec: ButtonSpec) => RenderElement
}

/** The row builders of one drawing, over the surface's `kit` and the pane's `width` in cells. */
export function layout(kit: Kit, width: number): Layout {
  const { Box, Text, Button } = kit
  const room = Number.isFinite(width) && width >= 1 ? Math.floor(width) : DEFAULT_WIDTH

  const piece = (part: Part): RenderNode => {
    const style: TextProps = {
      ...(part.color === undefined ? {} : { color: part.color }),
      ...(part.bold === true ? { bold: true } : {}),
      ...(part.dim === true ? { dimColor: true } : {}),
    }

    return Object.keys(style).length === 0 ? part.text : Text({ ...style, children: part.text })
  }
  // A row's parts, scrubbed and cut to `size` cells, drawn as one Text the engine would cut at the edge as well.
  const row = (parts: readonly Part[], size: number): RenderElement =>
    Text({
      wrap: 'truncate-end',
      children: fit(
        parts.map(part => ({ ...part, text: scrub(part.text) })),
        size,
      ).map(piece),
    })
  const line: Layout['line'] = parts => row(parts, room)
  const button: Layout['button'] = spec =>
    Button({
      key: spec.key,
      label: scrub(spec.label),
      plain: true,
      ...(spec.hotkey === undefined ? {} : { hotkey: spec.hotkey }),
      ...(spec.dim === true ? { dimColor: true } : {}),
      onPress: () => spec.onPress(),
    })

  return {
    room,
    line,
    header: (title, tail = '') =>
      line([
        { text: title, bold: true, color: HEAD },
        { text: tail === '' ? '' : ` ${tail}`, color: MUTED },
      ]),
    subheader: (title, tail = '') =>
      line([
        { text: title, bold: true, color: MUTED },
        { text: tail === '' ? '' : ` ${tail}`, color: MUTED },
      ]),
    empty: words => line([{ text: words, color: MUTED }]),
    wrapped: (text, options) => {
      const body = Text({
        wrap: 'wrap',
        color: options.color ?? MUTED,
        children: cut(clean(text), Math.max(1, options.chars)),
      })

      return options.indent === undefined || options.indent <= 0
        ? body
        : Box({ flexDirection: 'column', paddingLeft: options.indent, children: body })
    },
    button,
    withButton: (parts, spec) => {
      const taken = cells(scrub(spec.label)) + (spec.hotkey === undefined ? 0 : HOTKEY_CELLS)

      return Box({
        flexDirection: 'row',
        justifyContent: 'space-between',
        children: [row(parts, Math.max(1, room - taken - 1)), button(spec)],
      })
    },
  }
}
