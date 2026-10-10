// The status line's pure helpers (hooks/statusline-format.ts): gauges, the
// context, limit, effort, CI and compact-button segments, the two rows, and the
// number, model and git parsers. Nothing here touches the engine; time is
// passed in as epoch ms, so every figure is the same on every run.

import { describe, expect, test } from 'claude-code/testing'
import type { SessionRateLimit, SessionUsage } from 'claude-code'

import {
  baseName,
  cacheRatio,
  ciSegment,
  compactSpan,
  contextSegment,
  duration,
  effortGauge,
  elapsed,
  familyLabel,
  familyTotals,
  gauge,
  human,
  isSame,
  limitOf,
  limitsSegment,
  modelLabel,
  parseNumstat,
  parseStatus,
  placeOf,
  prOf,
  rowText,
  rowsOf,
  usageOf,
  weeklyOf,
  type Row,
  type RowsInput,
  type Segment,
  type StatusCi,
  type StatusSession,
  type StatusUsage,
} from '../hooks/statusline-format'

const NOW = Date.parse('2026-10-07T12:00:00Z')
const SECOND = 1_000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const NO_SESSION: StatusSession = { effort: null, agent: null, cacheRead: 0, cacheWrite: 0, uncached: 0 }

function usageWith(change: Partial<StatusUsage> = {}): StatusUsage {
  return {
    model: 'Opus 5.5 1M',
    tokens: 95_000,
    budget: 300_000,
    cost: 2.2259,
    fiveHour: 2,
    sevenDay: 49,
    sevenDayResetSec: 3 * 86_400 + 4 * 3_600,
    ...change,
  }
}

function ciWith(change: Partial<StatusCi> = {}): StatusCi {
  return { outcome: 'passed', isRunning: false, workflow: 'build', at: NOW - 3 * MINUTE, ...change }
}

/** What a segment draws, as plain text; a segment that is not drawn fails the test. */
function drawn(segment: Segment | null): string {
  expect(segment).not.toBeNull()

  return segment === null ? '' : rowText([segment])
}

/** The input of the kit test's fixtures: a repository with a pull request, and a session with usage. */
const KIT: RowsInput = {
  where: {
    label: 'widgets/pkg/sub',
    worktree: null,
    git: { branch: 'feature/demo', ahead: 2, behind: 1, added: 7, removed: 1, changed: 2 },
  },
  pr: { number: 42, review: 'approved' },
  usage: usageWith(),
  session: NO_SESSION,
  weekly: [
    { family: 'Sonnet', tokens: 8_200_000_000 },
    { family: 'Opus', tokens: 6_500_000_000 },
    { family: 'Haiku', tokens: 34_000_000 },
  ],
  hasNerdFont: false,
}

/** Everything the two rows can show at once. */
const FULL: RowsInput = {
  ...KIT,
  where: {
    label: 'widgets/pkg/sub',
    worktree: 'widgets-hotfix',
    git: { branch: 'feature/demo', ahead: 2, behind: 1, added: 7, removed: 1, changed: 2 },
  },
  ci: ciWith({ outcome: 'failed', workflow: 'build' }),
  compact: 'idle',
  nowMs: NOW,
  session: { effort: 'xhigh', agent: 'reviewer', cacheRead: 800, cacheWrite: 100, uncached: 100 },
}

describe('gauge', () => {
  test('fills the cell nearest the percentage', () => {
    expect(gauge(32, 10)).toBe('▰▰▰▱▱▱▱▱▱▱')
    expect(gauge(49, 5)).toBe('▰▰▱▱▱')
    expect(gauge(50, 5)).toBe('▰▰▰▱▱')
    expect(gauge(84, 10)).toBe('▰▰▰▰▰▰▰▰▱▱')
    expect(gauge(85, 10)).toBe('▰▰▰▰▰▰▰▰▰▱')
  })

  test('any use above zero fills one cell, and none at all fills none', () => {
    expect(gauge(0, 5)).toBe('▱▱▱▱▱')
    expect(gauge(0.1, 5)).toBe('▰▱▱▱▱')
    expect(gauge(2, 5)).toBe('▰▱▱▱▱')
    expect(gauge(2, 10)).toBe('▰▱▱▱▱▱▱▱▱▱')
    expect(gauge(49, 1)).toBe('▰')
    expect(gauge(0, 1)).toBe('▱')
  })

  test('100 fills every cell, and more than 100 does not overflow', () => {
    expect(gauge(100, 5)).toBe('▰▰▰▰▰')
    expect(gauge(99.9, 5)).toBe('▰▰▰▰▰')
    expect(gauge(250, 5)).toBe('▰▰▰▰▰')
    expect(gauge(Number.POSITIVE_INFINITY, 5)).toBe('▰▰▰▰▰')
    expect(gauge(100, 1)).toBe('▰')
  })

  test('a percentage at or below zero, or not a number, fills none', () => {
    expect(gauge(-5, 4)).toBe('▱▱▱▱')
    expect(gauge(-0, 4)).toBe('▱▱▱▱')
    expect(gauge(Number.NEGATIVE_INFINITY, 4)).toBe('▱▱▱▱')
    expect(gauge(Number.NaN, 4)).toBe('▱▱▱▱')
  })

  test('a width below one is empty, and a fractional width rounds down', () => {
    expect(gauge(50, 0)).toBe('')
    expect(gauge(50, -3)).toBe('')
    expect(gauge(50, Number.NaN)).toBe('')
    expect(gauge(50, Number.POSITIVE_INFINITY)).toBe('')
    expect(gauge(Number.POSITIVE_INFINITY, 0)).toBe('')
    expect(gauge(100, 2.9)).toBe('▰▰')
  })

  test('is always as wide as asked, used cells first, and never fills fewer as the percentage grows', () => {
    for (let width = 1; width <= 12; width += 1) {
      let before = 0

      for (let pct = 0; pct <= 100; pct += 1) {
        const cells = gauge(pct, width)
        const filled = [...cells].filter(cell => cell === '▰').length

        expect(cells).toBe(`${'▰'.repeat(filled)}${'▱'.repeat(width - filled)}`)
        expect(filled).toBeGreaterThanOrEqual(before)
        if (pct === 0) {
          expect(filled).toBe(0)
        } else {
          expect(filled).toBeGreaterThanOrEqual(1)
        }
        before = filled
      }
      expect(before).toBe(width)
    }
  })
})

describe('elapsed', () => {
  test('cuts a span down to its largest unit', () => {
    expect(elapsed(0, false)).toBe('0s')
    expect(elapsed(45 * SECOND, false)).toBe('45s')
    expect(elapsed(59_999, false)).toBe('59s')
    expect(elapsed(MINUTE, false)).toBe('1m')
    expect(elapsed(3 * MINUTE + 59 * SECOND, false)).toBe('3m')
    expect(elapsed(HOUR, false)).toBe('1h')
    expect(elapsed(5 * HOUR + 59 * MINUTE, false)).toBe('5h')
    expect(elapsed(DAY, false)).toBe('1d')
    expect(elapsed(2 * DAY + 23 * HOUR, false)).toBe('2d')
  })

  test('keeps the next unit while a run is going', () => {
    expect(elapsed(5 * SECOND, true)).toBe('5s')
    expect(elapsed(80 * SECOND, true)).toBe('1m20s')
    expect(elapsed(MINUTE + 5 * SECOND, true)).toBe('1m05s')
    expect(elapsed(HOUR + 5 * MINUTE, true)).toBe('1h05m')
    expect(elapsed(2 * DAY, true)).toBe('2d')
  })

  test('a span below zero or not a number is zero', () => {
    expect(elapsed(-30 * SECOND, false)).toBe('0s')
    expect(elapsed(Number.NaN, true)).toBe('0s')
    expect(elapsed(Number.POSITIVE_INFINITY, true)).toBe('0s')
  })
})

describe('context segment', () => {
  const STEPS = [
    { tokens: 0, percent: 0, text: 'ctx ▱▱▱▱▱▱▱▱▱▱ 0% 0/200k', tone: 'ok' },
    { tokens: 2_000, percent: 1, text: 'ctx ▰▱▱▱▱▱▱▱▱▱ 1% 2.0k/200k', tone: 'ok' },
    { tokens: 98_000, percent: 49, text: 'ctx ▰▰▰▰▰▱▱▱▱▱ 49% 98k/200k', tone: 'ok' },
    { tokens: 100_000, percent: 50, text: 'ctx ▰▰▰▰▰▱▱▱▱▱ 50% 100k/200k', tone: 'warn' },
    { tokens: 168_000, percent: 84, text: 'ctx ▰▰▰▰▰▰▰▰▱▱ 84% 168k/200k', tone: 'warn' },
    { tokens: 170_000, percent: 85, text: 'ctx ▰▰▰▰▰▰▰▰▰▱ 85% 170k/200k compact', tone: 'bad' },
    { tokens: 200_000, percent: 100, text: 'ctx ▰▰▰▰▰▰▰▰▰▰ 100% 200k/200k compact', tone: 'bad' },
  ] as const

  for (const step of STEPS) {
    test(`at ${step.percent}% draws the gauge, the figures and the ${step.tone} tone`, () => {
      const segment = contextSegment(usageWith({ tokens: step.tokens, budget: 200_000 }))
      const percent = segment.find(span => span.text.endsWith('%'))

      expect(drawn(segment)).toBe(`${step.text} ⟲ compact`)
      expect(percent?.tone).toBe(step.tone)
      expect(segment.some(span => span.text === ' compact')).toBe(step.percent >= 85)
    })
  }

  test('is the label, the toned cells, the muted rest, the figures and the button', () => {
    expect(contextSegment(usageWith())).toEqual([
      { text: 'ctx ', tone: 'muted' },
      { text: '▰▰▰', tone: 'ok' },
      { text: '▱▱▱▱▱▱▱', tone: 'muted' },
      { text: ' 32%', tone: 'ok' },
      { text: ' 95k/300k', tone: 'muted' },
      { text: ' ' },
      { text: '⟲ compact', tone: 'muted', press: 'compact' },
    ])
  })

  test('draws no used cells at 0% and no muted cells at 100%, with the warning in the bad tone', () => {
    expect(contextSegment(usageWith({ tokens: 0, budget: 200_000 })).slice(0, 3)).toEqual([
      { text: 'ctx ', tone: 'muted' },
      { text: '▱▱▱▱▱▱▱▱▱▱', tone: 'muted' },
      { text: ' 0%', tone: 'ok' },
    ])
    expect(contextSegment(usageWith({ tokens: 200_000, budget: 200_000 }))).toEqual([
      { text: 'ctx ', tone: 'muted' },
      { text: '▰▰▰▰▰▰▰▰▰▰', tone: 'bad' },
      { text: ' 100%', tone: 'bad' },
      { text: ' 200k/200k', tone: 'muted' },
      { text: ' compact', tone: 'bad' },
      { text: ' ' },
      { text: '⟲ compact', tone: 'muted', press: 'compact' },
    ])
  })

  test('judges the tone and the warning on the percentage as drawn', () => {
    // 49.6% is drawn as 50%, 84.5% as 85%, 84.4% as 84%.
    const at = (tokens: number) => contextSegment(usageWith({ tokens, budget: 1_000 }))

    expect(drawn(at(496))).toBe('ctx ▰▰▰▰▰▱▱▱▱▱ 50% 496/1.0k ⟲ compact')
    expect(at(496).find(span => span.text === ' 50%')?.tone).toBe('warn')
    expect(drawn(at(845))).toBe('ctx ▰▰▰▰▰▰▰▰▰▱ 85% 845/1.0k compact ⟲ compact')
    expect(at(845).find(span => span.text === ' 85%')?.tone).toBe('bad')
    expect(drawn(at(844))).toBe('ctx ▰▰▰▰▰▰▰▰▱▱ 84% 844/1.0k ⟲ compact')
    expect(at(844).find(span => span.text === ' 84%')?.tone).toBe('warn')
  })

  test('counts no tokens yet as none', () => {
    expect(drawn(contextSegment(usageWith({ tokens: null })))).toBe('ctx ▱▱▱▱▱▱▱▱▱▱ 0% 0/300k ⟲ compact')
    expect(drawn(contextSegment(usageWith({ tokens: Number.NaN })))).toBe('ctx ▱▱▱▱▱▱▱▱▱▱ 0% 0/300k ⟲ compact')
    expect(drawn(contextSegment(usageWith({ tokens: -150_000 })))).toBe('ctx ▱▱▱▱▱▱▱▱▱▱ 0% 0/300k ⟲ compact')
  })

  test('draws 0% against a budget of zero, never NaN or Infinity', () => {
    expect(drawn(contextSegment(usageWith({ tokens: null, budget: 0 })))).toBe('ctx ▱▱▱▱▱▱▱▱▱▱ 0% 0/0 ⟲ compact')
    expect(drawn(contextSegment(usageWith({ tokens: 5_000, budget: 0 })))).toBe('ctx ▱▱▱▱▱▱▱▱▱▱ 0% 5.0k/0 ⟲ compact')
  })

  test('stops at 100% when the tokens pass the budget, and shows the tokens as they are', () => {
    expect(drawn(contextSegment(usageWith({ tokens: 250_000, budget: 200_000 })))).toBe(
      'ctx ▰▰▰▰▰▰▰▰▰▰ 100% 250k/200k compact ⟲ compact',
    )
  })
})

describe('limits segment', () => {
  test('draws both windows with five-cell gauges and the 7-day reset', () => {
    expect(limitsSegment(usageWith())).toEqual([
      { text: '5h ', tone: 'muted' },
      { text: '▰', tone: 'ok' },
      { text: '▱▱▱▱', tone: 'muted' },
      { text: ' 2%', tone: 'ok' },
      { text: ' · ', tone: 'muted' },
      { text: '7d ', tone: 'muted' },
      { text: '▰▰', tone: 'ok' },
      { text: '▱▱▱', tone: 'muted' },
      { text: ' 49%', tone: 'ok' },
      { text: ' ↻3d4h', tone: 'muted' },
    ])
    expect(drawn(limitsSegment(usageWith()))).toBe('5h ▰▱▱▱▱ 2% · 7d ▰▰▱▱▱ 49% ↻3d4h')
  })

  test('leaves the reset out when the plan does not report it', () => {
    expect(drawn(limitsSegment(usageWith({ sevenDayResetSec: null })))).toBe('5h ▰▱▱▱▱ 2% · 7d ▰▰▱▱▱ 49%')
  })

  test('draws only the windows that are reported', () => {
    expect(drawn(limitsSegment(usageWith({ sevenDay: null, sevenDayResetSec: 90_000 })))).toBe('5h ▰▱▱▱▱ 2%')
    expect(drawn(limitsSegment(usageWith({ fiveHour: null })))).toBe('7d ▰▰▱▱▱ 49% ↻3d4h')
    expect(limitsSegment(usageWith({ fiveHour: null, sevenDay: null, sevenDayResetSec: null }))).toEqual([])
  })

  test('draws a window with nothing used, rather than leaving it out', () => {
    expect(drawn(limitsSegment(usageWith({ fiveHour: 0, sevenDay: null })))).toBe('5h ▱▱▱▱▱ 0%')
  })

  test('draws a window at 100% full, and past 100% as reported', () => {
    expect(drawn(limitsSegment(usageWith({ fiveHour: 100, sevenDay: 120, sevenDayResetSec: null })))).toBe(
      '5h ▰▰▰▰▰ 100% · 7d ▰▰▰▰▰ 120%',
    )
  })

  test('rounds the percentage and the cells the way the figure is drawn', () => {
    expect(drawn(limitsSegment(usageWith({ fiveHour: 23.5, sevenDay: 10, sevenDayResetSec: null })))).toBe(
      '5h ▰▱▱▱▱ 24% · 7d ▰▱▱▱▱ 10%',
    )
    expect(drawn(limitsSegment(usageWith({ fiveHour: 30, sevenDay: 50, sevenDayResetSec: null })))).toBe(
      '5h ▰▰▱▱▱ 30% · 7d ▰▰▰▱▱ 50%',
    )
  })

  test('tones the percentage ok below 50, warn below 80 and bad from there, on the figure as drawn', () => {
    const toneAt = (percent: number) => {
      const segment = limitsSegment(usageWith({ fiveHour: percent, sevenDay: null }))

      return segment.find(span => span.text.endsWith('%'))?.tone
    }

    expect(toneAt(0)).toBe('ok')
    expect(toneAt(49)).toBe('ok')
    expect(toneAt(49.4)).toBe('ok')
    expect(toneAt(49.5)).toBe('warn')
    expect(toneAt(50)).toBe('warn')
    expect(toneAt(79)).toBe('warn')
    expect(toneAt(79.4)).toBe('warn')
    expect(toneAt(79.5)).toBe('bad')
    expect(toneAt(80)).toBe('bad')
    expect(toneAt(100)).toBe('bad')
  })

  test('tones the used cells like the percentage and the rest muted', () => {
    const segment = limitsSegment(usageWith({ fiveHour: 85, sevenDay: null }))

    expect(segment.slice(1, 3)).toEqual([
      { text: '▰▰▰▰', tone: 'bad' },
      { text: '▱', tone: 'muted' },
    ])
  })
})

describe('effort', () => {
  const head = (effort: string | null) =>
    rowsOf({ ...KIT, where: null, pr: null, session: { ...NO_SESSION, effort } })[0]?.[0]

  const LEVELS = [
    ['low', '▮▯▯▯▯'],
    ['medium', '▮▮▯▯▯'],
    ['high', '▮▮▮▯▯'],
    ['xhigh', '▮▮▮▮▯'],
    ['max', '▮▮▮▮▮'],
  ] as const

  for (const [level, cells] of LEVELS) {
    test(`${level} fills ${[...cells].filter(cell => cell === '▮').length} of 5 cells after the model, muted`, () => {
      expect(effortGauge(level)).toBe(cells)
      expect(head(level)).toEqual([
        { text: 'Opus 5.5 1M', isBold: true },
        { text: ` ${cells} ${level}`, tone: 'muted' },
      ])
    })
  }

  test('shows a level it does not know as the word alone', () => {
    expect(effortGauge('turbo')).toBeNull()
    expect(effortGauge('')).toBeNull()
    expect(head('turbo')).toEqual([
      { text: 'Opus 5.5 1M', isBold: true },
      { text: ' turbo', tone: 'muted' },
    ])
  })

  test('does not guess at a level from part of its name', () => {
    expect(effortGauge('hi')).toBeNull()
    expect(effortGauge('highest')).toBeNull()
    expect(effortGauge('x')).toBeNull()
  })

  test('reads a known level with spaces around it', () => {
    expect(head(' high ')).toEqual([
      { text: 'Opus 5.5 1M', isBold: true },
      { text: ' ▮▮▮▯▯ high', tone: 'muted' },
    ])
  })

  test('shows no effort when there is none', () => {
    expect(head(null)).toEqual([{ text: 'Opus 5.5 1M', isBold: true }])
    expect(head('')).toEqual([{ text: 'Opus 5.5 1M', isBold: true }])
    expect(head('  ')).toEqual([{ text: 'Opus 5.5 1M', isBold: true }])
  })

  test('is drawn in the second row, after the model name', () => {
    const rows = rowsOf({ ...KIT, session: { ...NO_SESSION, effort: 'high' } })

    expect(rows.map(rowText)[1]?.startsWith('Opus 5.5 1M ▮▮▮▯▯ high │ ctx ')).toBe(true)
  })
})

describe('CI segment', () => {
  test('shows a passed run with how long ago it finished, muted', () => {
    expect(ciSegment(ciWith(), NOW)).toEqual([
      { text: 'CI ', tone: 'muted' },
      { text: '✓', tone: 'ok' },
      { text: ' 3m', tone: 'muted' },
    ])
    expect(drawn(ciSegment(ciWith(), NOW))).toBe('CI ✓ 3m')
  })

  test('cuts the age to its largest unit', () => {
    expect(drawn(ciSegment(ciWith({ at: NOW - 45 * SECOND }), NOW))).toBe('CI ✓ 45s')
    expect(drawn(ciSegment(ciWith({ at: NOW - 5 * HOUR - 20 * MINUTE }), NOW))).toBe('CI ✓ 5h')
    expect(drawn(ciSegment(ciWith({ at: NOW - 2 * DAY - 3 * HOUR }), NOW))).toBe('CI ✓ 2d')
  })

  test('shows a run still going with the time it has run, in the warn tone, ticking with the clock', () => {
    const running = ciWith({ outcome: 'pending', isRunning: true, at: NOW - 80 * SECOND })

    expect(ciSegment(running, NOW)).toEqual([
      { text: 'CI ', tone: 'muted' },
      { text: '● 1m20s', tone: 'warn' },
    ])
    expect(drawn(ciSegment(running, NOW + 10 * SECOND))).toBe('CI ● 1m30s')
    expect(drawn(ciSegment(running, NOW + 45 * SECOND))).toBe('CI ● 2m05s')
    expect(drawn(ciSegment({ ...running, at: NOW - 5 * SECOND }, NOW))).toBe('CI ● 5s')
    expect(drawn(ciSegment({ ...running, at: NOW - HOUR - 5 * MINUTE }, NOW))).toBe('CI ● 1h05m')
  })

  test('shows a queued run, pending and not yet running, as running', () => {
    expect(drawn(ciSegment(ciWith({ outcome: 'pending', isRunning: false, at: NOW - 20 * SECOND }), NOW))).toBe('CI ● 20s')
  })

  test('shows a run that says it is running as running, whatever the outcome it carries', () => {
    expect(drawn(ciSegment(ciWith({ outcome: 'passed', isRunning: true, at: NOW - 80 * SECOND }), NOW))).toBe('CI ● 1m20s')
    expect(drawn(ciSegment(ciWith({ outcome: 'failed', isRunning: true, at: NOW - 80 * SECOND }), NOW))).toBe('CI ● 1m20s')
  })

  test('shows a failed run with its workflow, in the error tone, and no time', () => {
    expect(ciSegment(ciWith({ outcome: 'failed', workflow: 'build' }), NOW)).toEqual([
      { text: 'CI ', tone: 'muted' },
      { text: '✗ build', tone: 'bad' },
    ])
    expect(drawn(ciSegment(ciWith({ outcome: 'failed', workflow: 'build', at: NOW - 9 * DAY }), NOW))).toBe('CI ✗ build')
  })

  test('shows a failed run on one line, and without a name when it has none', () => {
    expect(drawn(ciSegment(ciWith({ outcome: 'failed', workflow: '  build\n\ttest   suite \n' }), NOW))).toBe('CI ✗ build test suite')
    expect(drawn(ciSegment(ciWith({ outcome: 'failed', workflow: '' }), NOW))).toBe('CI ✗')
    expect(drawn(ciSegment(ciWith({ outcome: 'failed', workflow: ' \n ' }), NOW))).toBe('CI ✗')
  })

  test('shows a skipped run with how long ago, muted', () => {
    expect(ciSegment(ciWith({ outcome: 'skipped' }), NOW)).toEqual([
      { text: 'CI ', tone: 'muted' },
      { text: '⊘ 3m', tone: 'muted' },
    ])
  })

  test('leaves out what needs the time when the time is not given, but not a failure', () => {
    expect(ciSegment(ciWith(), undefined)).toBeNull()
    expect(ciSegment(ciWith({ outcome: 'skipped' }), undefined)).toBeNull()
    expect(ciSegment(ciWith({ outcome: 'pending', isRunning: true }), undefined)).toBeNull()
    expect(ciSegment(ciWith(), Number.NaN)).toBeNull()
    expect(drawn(ciSegment(ciWith({ outcome: 'failed', workflow: 'build' }), undefined))).toBe('CI ✗ build')
  })

  test('draws the mark alone when GitHub gave no time, and nothing without a clock but a failure', () => {
    for (const at of [Number.NaN, 0, -5]) {
      expect(drawn(ciSegment(ciWith({ at }), NOW))).toBe('CI ✓')
      expect(drawn(ciSegment(ciWith({ outcome: 'pending', isRunning: true, at }), NOW))).toBe('CI ● running')
      expect(drawn(ciSegment(ciWith({ outcome: 'skipped', at }), NOW))).toBe('CI ⊘')
      expect(drawn(ciSegment(ciWith({ outcome: 'failed', workflow: 'build', at }), NOW))).toBe('CI ✗ build')
    }
    expect(ciSegment(ciWith(), undefined)).toBeNull()
    expect(drawn(ciSegment(ciWith({ outcome: 'failed', workflow: 'build' }), undefined))).toBe('CI ✗ build')
  })

  test('keeps a failing check name to one short line', () => {
    expect(drawn(ciSegment(ciWith({ outcome: 'failed', workflow: `lint\u001b[2J\u0007 ${'x'.repeat(80)}` }), NOW))).toBe(
      `CI ✗ lint [2J ${'x'.repeat(31)}`,
    )
  })

  test('never shows a negative time when the run is ahead of the clock', () => {
    expect(drawn(ciSegment(ciWith({ at: NOW + 30 * SECOND }), NOW))).toBe('CI ✓ 0s')
    expect(drawn(ciSegment(ciWith({ outcome: 'pending', isRunning: true, at: NOW + 30 * SECOND }), NOW))).toBe('CI ● 0s')
  })

  test('is drawn in the first row after the pull request, before the agent', () => {
    const rows = rowsOf({ ...FULL, ci: ciWith(), nowMs: NOW })

    expect(rowText(rows[0] ?? [])).toBe(
      'widgets/pkg/sub │ ⎇ widgets-hotfix │ feature/demo ↑2↓1 +7/-1 ✱2 │ PR #42 ✓ │ CI ✓ 3m │ @reviewer',
    )
  })

  test('is drawn without a pull request, and not at all when there is no run', () => {
    expect(rowsOf({ ...KIT, pr: null, ci: ciWith(), nowMs: NOW }).map(rowText)[0]).toBe(
      'widgets/pkg/sub │ feature/demo ↑2↓1 +7/-1 ✱2 │ CI ✓ 3m',
    )
    expect(rowsOf({ ...KIT, ci: null, nowMs: NOW }).map(rowText)[0]).toBe('widgets/pkg/sub │ feature/demo ↑2↓1 +7/-1 ✱2 │ PR #42 ✓')
    expect(rowsOf({ ...KIT, nowMs: NOW }).map(rowText)[0]).toBe('widgets/pkg/sub │ feature/demo ↑2↓1 +7/-1 ✱2 │ PR #42 ✓')
  })

  test('is left out of the row without the time, except for a failure', () => {
    expect(rowsOf({ ...KIT, ci: ciWith() }).map(rowText)[0]).toBe('widgets/pkg/sub │ feature/demo ↑2↓1 +7/-1 ✱2 │ PR #42 ✓')
    expect(rowsOf({ ...KIT, ci: ciWith({ outcome: 'failed' }) }).map(rowText)[0]).toBe(
      'widgets/pkg/sub │ feature/demo ↑2↓1 +7/-1 ✱2 │ PR #42 ✓ │ CI ✗ build',
    )
  })

  test('is the only thing in the first row when nothing else is known', () => {
    const rows = rowsOf({ ...KIT, where: null, pr: null, usage: null, weekly: null, ci: ciWith(), nowMs: NOW })

    expect(rows.map(rowText)).toEqual(['CI ✓ 3m'])
  })

  test('takes a CiRun as it is', () => {
    const run = {
      workflow: 'deploy',
      outcome: 'passed',
      isRunning: false,
      at: NOW - MINUTE,
      url: 'https://example.com/run/1',
      sha: 'abc1234',
    } as const

    expect(drawn(ciSegment(run, NOW))).toBe('CI ✓ 1m')
  })
})

describe('compact button', () => {
  test('is "⟲ compact", muted and pressable, while idle', () => {
    expect(compactSpan('idle')).toEqual({ text: '⟲ compact', tone: 'muted', press: 'compact' })
  })

  test('is "⟲ confirm", in the warn tone and pressable, once armed', () => {
    expect(compactSpan('armed')).toEqual({ text: '⟲ confirm', tone: 'warn', press: 'compact' })
  })

  test('is "⟲ compacting…", muted and with nothing to press, while it runs', () => {
    const span = compactSpan('running')

    expect(span).toEqual({ text: '⟲ compacting…', tone: 'muted' })
    expect(span.press).toBeUndefined()
    expect(span).not.toHaveProperty('press')
  })

  test('is a fresh span each time, so a caller can change it', () => {
    const span = compactSpan('idle')

    span.text = 'changed'
    span.tone = 'bad'
    delete span.press
    expect(compactSpan('idle')).toEqual({ text: '⟲ compact', tone: 'muted', press: 'compact' })
  })

  test('is the last span of the context segment, after a space, idle unless told otherwise', () => {
    const usage = usageWith()

    expect(contextSegment(usage).slice(-2)).toEqual([{ text: ' ' }, { text: '⟲ compact', tone: 'muted', press: 'compact' }])
    expect(contextSegment(usage, 'idle').slice(-1)).toEqual([{ text: '⟲ compact', tone: 'muted', press: 'compact' }])
    expect(contextSegment(usage, 'armed').slice(-1)).toEqual([{ text: '⟲ confirm', tone: 'warn', press: 'compact' }])
    expect(contextSegment(usage, 'running').slice(-1)).toEqual([{ text: '⟲ compacting…', tone: 'muted' }])
  })

  test('comes after the compact warning when the context is nearly full', () => {
    const usage = usageWith({ tokens: 270_000 })

    expect(drawn(contextSegment(usage, 'idle'))).toBe('ctx ▰▰▰▰▰▰▰▰▰▱ 90% 270k/300k compact ⟲ compact')
    expect(drawn(contextSegment(usage, 'armed'))).toBe('ctx ▰▰▰▰▰▰▰▰▰▱ 90% 270k/300k compact ⟲ confirm')
    expect(drawn(contextSegment(usage, 'running'))).toBe('ctx ▰▰▰▰▰▰▰▰▰▱ 90% 270k/300k compact ⟲ compacting…')
  })

  test('is drawn by rowsOf in the state it is given, idle when it is not', () => {
    const second = (change: Partial<RowsInput>) => rowText(rowsOf({ ...KIT, ...change })[1] ?? [])

    expect(second({})).toContain('32% 95k/300k ⟲ compact │')
    expect(second({ compact: 'idle' })).toContain('32% 95k/300k ⟲ compact │')
    expect(second({ compact: 'armed' })).toContain('32% 95k/300k ⟲ confirm │')
    expect(second({ compact: 'running' })).toContain('32% 95k/300k ⟲ compacting… │')
  })

  test('is the only span of the rows that can be pressed, and only while it can', () => {
    const pressable = (compact: RowsInput['compact']) =>
      rowsOf({ ...FULL, compact })
        .flat(2)
        .filter(span => span.press !== undefined)
        .map(span => span.text)

    expect(pressable('idle')).toEqual(['⟲ compact'])
    expect(pressable('armed')).toEqual(['⟲ confirm'])
    expect(pressable('running')).toEqual([])
    expect(pressable(undefined)).toEqual(['⟲ compact'])
  })

  test('is not drawn when there is no usage to draw the context from', () => {
    const rows = rowsOf({ ...KIT, usage: null, compact: 'armed' })

    expect(rows.flat(2).some(span => span.press !== undefined)).toBe(false)
  })
})

describe('rowsOf', () => {
  test('draws the kit fixtures: a repository with a pull request, and a session with usage', () => {
    expect(rowsOf(KIT).map(rowText)).toEqual([
      'widgets/pkg/sub │ feature/demo ↑2↓1 +7/-1 ✱2 │ PR #42 ✓',
      'Opus 5.5 1M │ ctx ▰▰▰▱▱▱▱▱▱▱ 32% 95k/300k ⟲ compact │ $2.23 │ 5h ▰▱▱▱▱ 2% · 7d ▰▰▱▱▱ 49% ↻3d4h │ 7d Sonnet 8.2B Opus 6.5B Haiku 34M',
    ])
  })

  test('draws everything at once, in the order of the rows', () => {
    expect(rowsOf(FULL).map(rowText)).toEqual([
      'widgets/pkg/sub │ ⎇ widgets-hotfix │ feature/demo ↑2↓1 +7/-1 ✱2 │ PR #42 ✓ │ CI ✗ build │ @reviewer',
      [
        'Opus 5.5 1M ▮▮▮▮▯ xhigh',
        'ctx ▰▰▰▱▱▱▱▱▱▱ 32% 95k/300k ⟲ compact',
        'cache 80%',
        '$2.23',
        '5h ▰▱▱▱▱ 2% · 7d ▰▰▱▱▱ 49% ↻3d4h',
        '7d Sonnet 8.2B Opus 6.5B Haiku 34M',
      ].join(' │ '),
    ])
  })

  test('draws a running compaction and a run in progress', () => {
    const rows = rowsOf({
      ...FULL,
      ci: ciWith({ outcome: 'pending', isRunning: true, at: NOW - 80 * SECOND }),
      compact: 'running',
      usage: usageWith({ tokens: 270_000, fiveHour: 83, sevenDay: 61, sevenDayResetSec: 2 * 3_600 + 5 * 60 }),
    })

    expect(rows.map(rowText)).toEqual([
      'widgets/pkg/sub │ ⎇ widgets-hotfix │ feature/demo ↑2↓1 +7/-1 ✱2 │ PR #42 ✓ │ CI ● 1m20s │ @reviewer',
      [
        'Opus 5.5 1M ▮▮▮▮▯ xhigh',
        'ctx ▰▰▰▰▰▰▰▰▰▱ 90% 270k/300k compact ⟲ compacting…',
        'cache 80%',
        '$2.23',
        '5h ▰▰▰▰▱ 83% · 7d ▰▰▰▱▱ 61% ↻2h05m',
        '7d Sonnet 8.2B Opus 6.5B Haiku 34M',
      ].join(' │ '),
    ])
  })

  test('draws the same rows from an input made before CI and the compact button existed', () => {
    const legacy: RowsInput = {
      where: KIT.where,
      pr: KIT.pr,
      usage: KIT.usage,
      session: KIT.session,
      weekly: KIT.weekly,
      hasNerdFont: false,
    }

    expect(rowsOf(legacy).map(rowText)).toEqual(rowsOf(KIT).map(rowText))
    expect(rowsOf(legacy).map(rowText)).toEqual(rowsOf({ ...KIT, ci: null, compact: 'idle', nowMs: undefined }).map(rowText))
  })

  test('draws the directory alone outside a git repository, and a linked worktree after it', () => {
    const where = { label: 'scratch', worktree: null, git: null }

    expect(rowsOf({ ...KIT, where, pr: null, usage: null, weekly: null }).map(rowText)).toEqual(['scratch'])
    expect(rowsOf({ ...KIT, where: { ...where, worktree: 'scratch-2' }, pr: null, usage: null, weekly: null }).map(rowText)).toEqual([
      'scratch │ ⎇ scratch-2',
    ])
  })

  test('draws the branch with the Nerd Font glyph only when asked to', () => {
    const first = (hasNerdFont: boolean) => rowText(rowsOf({ ...KIT, hasNerdFont })[0] ?? [])

    expect(first(false)).toBe('widgets/pkg/sub │ feature/demo ↑2↓1 +7/-1 ✱2 │ PR #42 ✓')
    expect(first(true)).toBe('widgets/pkg/sub │ \uf418 feature/demo ↑2↓1 +7/-1 ✱2 │ PR #42 ✓')
  })

  test('draws only the git figures that are not zero', () => {
    const first = (git: NonNullable<RowsInput['where']>['git']) =>
      rowText(rowsOf({ ...KIT, where: { label: 'widgets', worktree: null, git }, pr: null, usage: null, weekly: null })[0] ?? [])
    const base = { branch: 'main', ahead: 0, behind: 0, added: 0, removed: 0, changed: 0 }

    expect(first(base)).toBe('widgets │ main')
    expect(first({ ...base, ahead: 2 })).toBe('widgets │ main ↑2')
    expect(first({ ...base, behind: 3 })).toBe('widgets │ main ↓3')
    expect(first({ ...base, added: 4 })).toBe('widgets │ main +4/-0')
    expect(first({ ...base, removed: 5 })).toBe('widgets │ main +0/-5')
    expect(first({ ...base, changed: 6 })).toBe('widgets │ main ✱6')
  })

  test('marks the pull request by its review', () => {
    const first = (review: NonNullable<RowsInput['pr']>['review']) =>
      rowText(rowsOf({ ...KIT, where: null, pr: { number: 7, review }, usage: null, weekly: null })[0] ?? [])

    expect(first(null)).toBe('PR #7')
    expect(first('approved')).toBe('PR #7 ✓')
    expect(first('changes_requested')).toBe('PR #7 ✗')
    expect(first('pending')).toBe('PR #7 ○')
    expect(first('draft')).toBe('PR #7 ◌')
  })

  test('leaves out the segments it has nothing for, and the rows that end up empty', () => {
    const nothing: RowsInput = { where: null, pr: null, usage: null, session: NO_SESSION, weekly: null, hasNerdFont: false }

    expect(rowsOf(nothing)).toEqual([])
    expect(rowsOf({ ...nothing, session: { ...NO_SESSION, agent: 'reviewer' } }).map(rowText)).toEqual(['@reviewer'])
    expect(rowsOf({ ...nothing, weekly: [] })).toEqual([])
    expect(rowsOf({ ...nothing, session: { ...NO_SESSION, cacheRead: 1 } }).map(rowText)).toEqual(['cache 100%'])
    expect(rowsOf({ ...KIT, where: null, pr: null }).map(rowText)).toHaveLength(1)
    expect(rowsOf({ ...KIT, usage: null, weekly: null }).map(rowText)).toEqual(['widgets/pkg/sub │ feature/demo ↑2↓1 +7/-1 ✱2 │ PR #42 ✓'])
  })

  test('draws the cost, the cache ratio and the limits only when they are known', () => {
    const second = (usage: StatusUsage | null, session: StatusSession = NO_SESSION) =>
      rowText(rowsOf({ ...KIT, where: null, pr: null, weekly: null, usage, session })[0] ?? [])

    expect(second(usageWith({ cost: null, fiveHour: null, sevenDay: null, sevenDayResetSec: null }))).toBe(
      'Opus 5.5 1M │ ctx ▰▰▰▱▱▱▱▱▱▱ 32% 95k/300k ⟲ compact',
    )
    expect(second(usageWith({ cost: 0, fiveHour: null, sevenDay: null }))).toBe(
      'Opus 5.5 1M │ ctx ▰▰▰▱▱▱▱▱▱▱ 32% 95k/300k ⟲ compact │ $0.00',
    )
    expect(second(null, { ...NO_SESSION, cacheRead: 3, uncached: 1 })).toBe('cache 75%')
  })

  test('tones the cost warn from $5.00 as drawn, and the cache ratio warn below 70%', () => {
    const toneOf = (row: Row | undefined, text: string) => row?.flat().find(span => span.text === text)?.tone
    const costRow = (cost: number) => rowsOf({ ...KIT, where: null, pr: null, weekly: null, usage: usageWith({ cost }) })[0]
    const cacheRow = (cacheRead: number) => {
      const session = { ...NO_SESSION, cacheRead, uncached: 100 - cacheRead }

      return rowsOf({ ...KIT, where: null, pr: null, usage: null, weekly: null, session })[0]
    }

    expect(toneOf(costRow(4.99), '$4.99')).toBe('ok')
    expect(toneOf(costRow(4.996), '$5.00')).toBe('warn')
    expect(toneOf(costRow(5), '$5.00')).toBe('warn')
    expect(toneOf(cacheRow(69), '69%')).toBe('warn')
    expect(toneOf(cacheRow(70), '70%')).toBe('ok')
  })
})

describe('rowText', () => {
  test('joins the spans of a segment, and the segments with a bar', () => {
    expect(rowText([[{ text: 'a', tone: 'ok' }, { text: 'b' }], [{ text: 'c', isBold: true }]])).toBe('ab │ c')
  })

  test('is empty for an empty row, and a lone segment has no bar', () => {
    expect(rowText([])).toBe('')
    expect(rowText([[{ text: 'only' }]])).toBe('only')
  })
})

describe('isSame', () => {
  test('is true for plain data of the same shape and values, and false when a value differs', () => {
    expect(isSame({ a: [1, { b: 'x' }], c: null }, { a: [1, { b: 'x' }], c: null })).toBe(true)
    expect(isSame({ a: [1, { b: 'x' }] }, { a: [1, { b: 'y' }] })).toBe(false)
    expect(isSame(null, { a: 1 })).toBe(false)
    expect(isSame([1, 2], [1, 2, 3])).toBe(false)
    expect(isSame('x', 'x')).toBe(true)
  })
})

describe('human', () => {
  test('keeps small numbers whole', () => {
    expect(human(0)).toBe('0')
    expect(human(950)).toBe('950')
    expect(human(999)).toBe('999')
    expect(human(999.4)).toBe('999')
  })

  test('shows one decimal below 10 of a unit, and none from there', () => {
    expect(human(1250)).toBe('1.3k')
    expect(human(2_000)).toBe('2.0k')
    expect(human(9_949)).toBe('9.9k')
    expect(human(9_950)).toBe('10k')
    expect(human(10_500)).toBe('11k')
    expect(human(95_000)).toBe('95k')
    expect(human(8_200_000_000)).toBe('8.2B')
    expect(human(34_000_000)).toBe('34M')
    expect(human(2_500_000_000_000)).toBe('2.5T')
  })

  test('moves to the next unit instead of showing 1000 or 10.0', () => {
    expect(human(999.5)).toBe('1.0k')
    expect(human(9_960)).toBe('10k')
    expect(human(999_499)).toBe('999k')
    expect(human(999_500)).toBe('1.0M')
    expect(human(999_500_000)).toBe('1.0B')
    expect(human(1e15)).toBe('1000T')
  })

  test('shows zero for a number that is negative or not finite', () => {
    expect(human(-5)).toBe('0')
    expect(human(Number.NaN)).toBe('0')
    expect(human(Number.POSITIVE_INFINITY)).toBe('0')
  })
})

describe('duration', () => {
  test('rounds to the nearest minute, and shows the two largest units', () => {
    expect(duration(0)).toBe('0m')
    expect(duration(29)).toBe('0m')
    expect(duration(30)).toBe('1m')
    expect(duration(90)).toBe('2m')
    expect(duration(3_599)).toBe('1h00m')
    expect(duration(3_600)).toBe('1h00m')
    expect(duration(3_660)).toBe('1h01m')
    expect(duration(7_500)).toBe('2h05m')
    expect(duration(86_340)).toBe('23h59m')
    expect(duration(86_400)).toBe('1d0h')
    expect(duration(90_000)).toBe('1d1h')
    expect(duration(3 * 86_400 + 4 * 3_600)).toBe('3d4h')
  })

  test('shows 0m for a span that is negative or not finite', () => {
    expect(duration(-5)).toBe('0m')
    expect(duration(-100_000)).toBe('0m')
    expect(duration(Number.NaN)).toBe('0m')
    expect(duration(Number.POSITIVE_INFINITY)).toBe('0m')
  })
})

describe('modelLabel', () => {
  test('reads the family and the version off a Claude model id', () => {
    expect(modelLabel('claude-opus-5-5[1m]', 200_000)).toBe('Opus 5.5 1M')
    expect(modelLabel('claude-3-5-sonnet-20241022', 200_000)).toBe('Sonnet 3.5')
    expect(modelLabel('us.anthropic.claude-opus-4-1-20250805-v1:0', 200_000)).toBe('Opus 4.1')
    expect(modelLabel('claude-sonnet-4-5@20250929', 200_000)).toBe('Sonnet 4.5')
    expect(modelLabel('claude-haiku-4-5-20251001', 200_000)).toBe('Haiku 4.5')
    expect(modelLabel('claude-opus-4', 200_000)).toBe('Opus 4')
  })

  test('adds 1M for a [1m] id or a window of a million tokens', () => {
    expect(modelLabel('claude-opus-5-5', 200_000)).toBe('Opus 5.5')
    expect(modelLabel('claude-opus-5-5', 1_000_000)).toBe('Opus 5.5 1M')
    expect(modelLabel('claude-opus-5-5[1M]', 200_000)).toBe('Opus 5.5 1M')
  })

  test('shows an id that names no Claude model as given', () => {
    expect(modelLabel('gpt-4o', 200_000)).toBe('gpt-4o')
    expect(modelLabel('  gpt-4o  ', 200_000)).toBe('gpt-4o')
    expect(modelLabel('', 200_000)).toBe('?')
    expect(modelLabel('   ', 200_000)).toBe('?')
  })
})

describe('familyLabel', () => {
  test('names the family of a model id', () => {
    expect(familyLabel('claude-opus-5-5')).toBe('Opus')
    expect(familyLabel('claude-3-5-sonnet-20241022')).toBe('Sonnet')
    expect(familyLabel('claude-haiku-4-5-20251001')).toBe('Haiku')
    expect(familyLabel('claude-fable-1')).toBe('Fable')
    expect(familyLabel('CLAUDE-OPUS-5')).toBe('Opus')
  })

  test('names another model by its first word, cut to eight characters', () => {
    expect(familyLabel('gpt-4o')).toBe('Gpt')
    expect(familyLabel('acme/widget-4')).toBe('Widget')
    expect(familyLabel('averyveryverylongname-1')).toBe('Averyver')
  })
})

describe('familyTotals', () => {
  test('sums the models of a family, largest first', () => {
    expect(
      familyTotals({
        'claude-opus-5-5': 100,
        'claude-sonnet-5-5': 120,
        'claude-opus-4-1-20250805': 50,
      }),
    ).toEqual([
      { family: 'Opus', tokens: 150 },
      { family: 'Sonnet', tokens: 120 },
    ])
  })

  test('keeps the top three families', () => {
    expect(
      familyTotals({
        'claude-fable-1': 100,
        'claude-haiku-4-5': 200,
        'claude-sonnet-5-5': 300,
        'claude-opus-5-5': 400,
      }),
    ).toEqual([
      { family: 'Opus', tokens: 400 },
      { family: 'Sonnet', tokens: 300 },
      { family: 'Haiku', tokens: 200 },
    ])
  })

  test('drops what is zero, negative, not finite or not a number', () => {
    expect(
      familyTotals({
        'claude-opus-5-5': 0,
        '<synthetic>': 0,
        'claude-sonnet-5-5': -3,
        'claude-fable-1': Number.NaN,
        'claude-opus-4-1': '5',
        'gpt-4o': null,
        'claude-haiku-4-5': 5,
      }),
    ).toEqual([{ family: 'Haiku', tokens: 5 }])
    expect(familyTotals({})).toEqual([])
  })
})

describe('weeklyOf', () => {
  test('reads the top families off the script output', () => {
    const stdout = JSON.stringify({
      updated: 1,
      since: '2026-09-30T12',
      by_model: {
        'claude-opus-5-5': 6_500_000_000,
        'claude-sonnet-5-5': 8_200_000_000,
        'claude-haiku-4-5-20251001': 34_000_000,
        '<synthetic>': 0,
      },
    })

    expect(weeklyOf(stdout)).toEqual([
      { family: 'Sonnet', tokens: 8_200_000_000 },
      { family: 'Opus', tokens: 6_500_000_000 },
      { family: 'Haiku', tokens: 34_000_000 },
    ])
  })

  test('is null for output that is not the script`s, or that holds nothing', () => {
    expect(weeklyOf('')).toBeNull()
    expect(weeklyOf('not json {')).toBeNull()
    expect(weeklyOf('null')).toBeNull()
    expect(weeklyOf('[]')).toBeNull()
    expect(weeklyOf('"text"')).toBeNull()
    expect(weeklyOf('42')).toBeNull()
    expect(weeklyOf('{}')).toBeNull()
    expect(weeklyOf('{"by_model": null}')).toBeNull()
    expect(weeklyOf('{"by_model": "x"}')).toBeNull()
    expect(weeklyOf('{"by_model": []}')).toBeNull()
    expect(weeklyOf('{"by_model": {}}')).toBeNull()
    expect(weeklyOf('{"by_model": {"claude-opus-5-5": 0, "claude-haiku-4-5": "9"}}')).toBeNull()
  })
})

describe('parseStatus', () => {
  const OID = '0123456789abcdef0123456789abcdef01234567'

  test('reads the branch, the counts ahead and behind, and the changed files', () => {
    const stdout = [
      `# branch.oid ${OID}`,
      '# branch.head feature/demo',
      '# branch.upstream origin/feature/demo',
      '# branch.ab +2 -1',
      '1 .M N... 100644 100644 100644 aaa bbb src/a.ts',
      '1 M. N... 100644 100644 100644 ccc ddd src/b.ts',
      '2 R. N... 100644 100644 100644 eee fff R100 src/new.ts\tsrc/old.ts',
      'u UU N... 100644 100644 100644 100644 aaa bbb ccc src/conflict.ts',
      '? notes.txt',
      '! build/out.js',
      '',
    ].join('\n')

    expect(parseStatus(stdout)).toEqual({ branch: 'feature/demo', isUnborn: false, ahead: 2, behind: 1, changed: 4 })
  })

  test('names a detached head by its short sha', () => {
    expect(parseStatus([`# branch.oid ${OID}`, '# branch.head (detached)', ''].join('\n'))).toEqual({
      branch: 'HEAD 0123456',
      isUnborn: false,
      ahead: 0,
      behind: 0,
      changed: 0,
    })
  })

  test('knows a branch with no commit yet', () => {
    expect(parseStatus(['# branch.oid (initial)', '# branch.head main', '? README.md', ''].join('\n'))).toEqual({
      branch: 'main',
      isUnborn: true,
      ahead: 0,
      behind: 0,
      changed: 0,
    })
  })

  test('counts nothing ahead or behind without an upstream, or with a count it cannot read', () => {
    expect(parseStatus([`# branch.oid ${OID}`, '# branch.head main', ''].join('\n'))).toMatchObject({ ahead: 0, behind: 0 })
    expect(parseStatus([`# branch.oid ${OID}`, '# branch.head main', '# branch.ab nonsense', ''].join('\n'))).toMatchObject({
      ahead: 0,
      behind: 0,
    })
    expect(parseStatus([`# branch.oid ${OID}`, '# branch.head main', '# branch.ab +0 -12', ''].join('\n'))).toMatchObject({
      ahead: 0,
      behind: 12,
    })
  })

  test('reads output with nothing in it as an unnamed branch', () => {
    expect(parseStatus('')).toEqual({ branch: '?', isUnborn: false, ahead: 0, behind: 0, changed: 0 })
  })
})

describe('parseNumstat', () => {
  test('sums the added and removed lines, and counts a binary file as nothing', () => {
    expect(parseNumstat('3\t1\tsrc/a.ts\n-\t-\tlogo.png\n4\t0\tsrc/b.ts\n')).toEqual({ added: 7, removed: 1 })
  })

  test('reads a renamed file and a file with only removals', () => {
    expect(parseNumstat('0\t12\told.ts\n2\t2\tsrc/{a => b}.ts\n')).toEqual({ added: 2, removed: 14 })
  })

  test('is zero for no output and for lines that are not numstat lines', () => {
    expect(parseNumstat('')).toEqual({ added: 0, removed: 0 })
    expect(parseNumstat('warning: something\n\n3x\t1\tf.ts\n3\n')).toEqual({ added: 0, removed: 0 })
  })
})

describe('baseName', () => {
  test('is the last part of a path, with either kind of separator and a trailing one', () => {
    expect(baseName('/home/alice/widgets')).toBe('widgets')
    expect(baseName('/home/alice/widgets/')).toBe('widgets')
    expect(baseName('C:\\Users\\alice\\widgets')).toBe('widgets')
    expect(baseName('widgets')).toBe('widgets')
  })

  test('is the path itself when it has no parts', () => {
    expect(baseName('/')).toBe('/')
    expect(baseName('')).toBe('')
  })
})

describe('placeOf', () => {
  test('names the main working tree by its directory, with no worktree', () => {
    expect(placeOf('/home/alice/widgets', '', '/home/alice/widgets/.git')).toEqual({ label: 'widgets', worktree: null })
    expect(placeOf('/home/alice/widgets', '', '.git')).toEqual({ label: 'widgets', worktree: null })
  })

  test('adds the path inside the repository', () => {
    expect(placeOf('/home/alice/widgets', 'pkg/sub/', '/home/alice/widgets/.git')).toEqual({ label: 'widgets/pkg/sub', worktree: null })
    expect(placeOf('/home/alice/widgets', 'pkg\\sub\\', '/home/alice/widgets/.git')).toEqual({ label: 'widgets/pkg/sub', worktree: null })
  })

  test('names a linked worktree after its main repository, and the worktree by its directory', () => {
    expect(placeOf('/home/alice/widgets-hotfix', '', '/home/alice/widgets/.git/worktrees/widgets-hotfix')).toEqual({
      label: 'widgets',
      worktree: 'widgets-hotfix',
    })
    expect(placeOf('/home/alice/widgets-hotfix', 'api/', '/home/alice/widgets/.git/worktrees/widgets-hotfix/')).toEqual({
      label: 'widgets/api',
      worktree: 'widgets-hotfix',
    })
    expect(placeOf('C:\\work\\widgets-hotfix', '', 'C:\\work\\widgets\\.git\\worktrees\\widgets-hotfix')).toEqual({
      label: 'widgets',
      worktree: 'widgets-hotfix',
    })
  })

  test('names a worktree of a bare repository after the repository without its .git', () => {
    expect(placeOf('/srv/work/hotfix', '', '/srv/git/widgets.git/worktrees/hotfix')).toEqual({ label: 'widgets', worktree: 'hotfix' })
    expect(placeOf('/srv/work/hotfix', 'src/', '/srv/git/widgets/worktrees/hotfix')).toEqual({ label: 'widgets/src', worktree: 'hotfix' })
  })

  test('does not take a submodule`s git directory for a worktree`s', () => {
    expect(placeOf('/home/alice/widgets/lib', '', '/home/alice/widgets/.git/modules/lib')).toEqual({ label: 'lib', worktree: null })
  })
})

describe('prOf', () => {
  const open = (change: Record<string, unknown>) =>
    JSON.stringify({ number: 42, state: 'OPEN', isDraft: false, reviewDecision: '', ...change })

  test('reads the number and the review decision of an open pull request', () => {
    expect(prOf(open({ reviewDecision: 'APPROVED' }))).toEqual({ number: 42, review: 'approved' })
    expect(prOf(open({ reviewDecision: 'CHANGES_REQUESTED' }))).toEqual({ number: 42, review: 'changes_requested' })
    expect(prOf(open({ reviewDecision: 'REVIEW_REQUIRED' }))).toEqual({ number: 42, review: 'pending' })
    expect(prOf(open({ reviewDecision: '' }))).toEqual({ number: 42, review: null })
    expect(prOf(open({ reviewDecision: null }))).toEqual({ number: 42, review: null })
  })

  test('is a draft before anything else', () => {
    expect(prOf(open({ isDraft: true, reviewDecision: 'APPROVED' }))).toEqual({ number: 42, review: 'draft' })
  })

  test('is null for a pull request that is not open', () => {
    expect(prOf(open({ state: 'MERGED' }))).toBeNull()
    expect(prOf(open({ state: 'CLOSED' }))).toBeNull()
    expect(prOf(open({ state: undefined }))).toBeNull()
  })

  test('is null for output that is not a pull request', () => {
    expect(prOf('')).toBeNull()
    expect(prOf('no pull requests found')).toBeNull()
    expect(prOf('null')).toBeNull()
    expect(prOf('{}')).toBeNull()
    expect(prOf(open({ number: '42' }))).toBeNull()
  })
})

describe('limitOf', () => {
  const LIMITS: SessionRateLimit[] = [
    { kind: 'five_hour', percentUsed: 2, resetsAt: '2026-10-07T15:00:00Z' },
    { kind: 'seven_day', percentUsed: 49, resetsAt: '2026-10-10T16:00:00Z' },
  ]

  test('reads the percentage of a window and the seconds left until it resets', () => {
    expect(limitOf(LIMITS, 'five_hour', NOW)).toEqual({ percent: 2, resetSec: 3 * 3_600 })
    expect(limitOf(LIMITS, 'seven_day', NOW)).toEqual({ percent: 49, resetSec: 3 * 86_400 + 4 * 3_600 })
  })

  test('is null once the window has reset, and at the moment it does', () => {
    expect(limitOf(LIMITS, 'five_hour', Date.parse('2026-10-07T15:00:01Z'))).toBeNull()
    expect(limitOf(LIMITS, 'five_hour', Date.parse('2026-10-07T15:00:00Z'))).toBeNull()
    expect(limitOf(LIMITS, 'five_hour', Date.parse('2026-10-07T14:59:59Z'))).toEqual({ percent: 2, resetSec: 1 })
  })

  test('keeps the percentage when the reset is not reported or cannot be read', () => {
    expect(limitOf([{ kind: 'five_hour', percentUsed: 7 }], 'five_hour', NOW)).toEqual({ percent: 7, resetSec: null })
    expect(limitOf([{ kind: 'five_hour', percentUsed: 7, resetsAt: 'soon' }], 'five_hour', NOW)).toEqual({ percent: 7, resetSec: null })
  })

  test('is null for a window that is not reported, or has no percentage', () => {
    expect(limitOf(LIMITS, 'spend_limit', NOW)).toBeNull()
    expect(limitOf([], 'five_hour', NOW)).toBeNull()
    expect(limitOf([{ kind: 'five_hour', percentUsed: Number.NaN }], 'five_hour', NOW)).toBeNull()
  })
})

describe('usageOf', () => {
  const FIGURES: SessionUsage = {
    startedAt: NOW - HOUR,
    context: { tokens: 95_000, window: 1_000_000, percent: 10 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 2, resetsAt: '2026-10-07T15:00:00Z' },
      { kind: 'seven_day', percentUsed: 49, resetsAt: '2026-10-10T16:00:00Z' },
    ],
    cost: { usd: 2.2259 },
  }

  test('gathers the model, the context, the cost and the limits', () => {
    expect(usageOf(FIGURES, 'claude-opus-5-5', 300_000, NOW)).toEqual({
      model: 'Opus 5.5 1M',
      tokens: 95_000,
      budget: 300_000,
      cost: 2.2259,
      fiveHour: 2,
      sevenDay: 49,
      sevenDayResetSec: 3 * 86_400 + 4 * 3_600,
    })
  })

  test('measures against the compaction window only when it is smaller than the model`s', () => {
    const budgetFor = (budget: number | null) => usageOf(FIGURES, 'claude-opus-5-5', budget, NOW).budget

    expect(budgetFor(300_000)).toBe(300_000)
    expect(budgetFor(null)).toBe(1_000_000)
    expect(budgetFor(0)).toBe(1_000_000)
    expect(budgetFor(-1)).toBe(1_000_000)
    expect(budgetFor(1_000_000)).toBe(1_000_000)
    expect(budgetFor(2_000_000)).toBe(1_000_000)
  })

  test('takes a window of 200k when the engine reports none', () => {
    const none: SessionUsage = { ...FIGURES, context: { tokens: 1_000, window: 0 } }

    expect(usageOf(none, 'claude-opus-5-5', null, NOW)).toMatchObject({ model: 'Opus 5.5', budget: 200_000, tokens: 1_000 })
    expect(usageOf(none, 'claude-opus-5-5[1m]', null, NOW)).toMatchObject({ model: 'Opus 5.5 1M', budget: 200_000 })
  })

  test('leaves out what the engine does not have', () => {
    const bare: SessionUsage = { startedAt: NOW, context: { window: 200_000 }, rateLimits: [] }

    expect(usageOf(bare, 'gpt-4o', null, NOW)).toEqual({
      model: 'gpt-4o',
      tokens: null,
      budget: 200_000,
      cost: null,
      fiveHour: null,
      sevenDay: null,
      sevenDayResetSec: null,
    })
  })

  test('leaves out a window that has reset', () => {
    const later = Date.parse('2026-10-10T16:00:01Z')

    expect(usageOf(FIGURES, 'claude-opus-5-5', 300_000, later)).toMatchObject({ fiveHour: null, sevenDay: null, sevenDayResetSec: null })
  })
})

describe('cacheRatio', () => {
  test('is the share of cache reads in every input token, as a whole percentage', () => {
    expect(cacheRatio({ ...NO_SESSION, cacheRead: 800, cacheWrite: 100, uncached: 100 })).toBe(80)
    expect(cacheRatio({ ...NO_SESSION, cacheRead: 1, cacheWrite: 1, uncached: 1 })).toBe(33)
    expect(cacheRatio({ ...NO_SESSION, cacheRead: 2, cacheWrite: 1, uncached: 0 })).toBe(67)
    expect(cacheRatio({ ...NO_SESSION, cacheRead: 5 })).toBe(100)
    expect(cacheRatio({ ...NO_SESSION, uncached: 5 })).toBe(0)
  })

  test('is null before the first request', () => {
    expect(cacheRatio(NO_SESSION)).toBeNull()
  })
})
