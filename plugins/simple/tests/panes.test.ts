import { describe, expect, test } from 'claude-code/testing'
import type { PaneCloseArgs, PaneOpenArgs, UiPane } from 'claude-code'

import type { Host } from '../hooks/host'
import { createPanes, parseArgs, PANES, USAGE, type PaneId } from '../hooks/panes'

// The side panes' own rules (hooks/panes.ts) driven by a hand-written Host: what
// /workbench was asked, and what the person closing a pane by hand leaves
// behind. That close (`ui.close` with the origin `person`) cannot be raised
// from the engine's kit, so `closed()` is read here, and the memory it writes
// is read back by a second set of panes, as the next session would. What the
// command does to the panes through the engine is in mod.test.tsx.

const WORK: PaneId = 'simple-work'
const SESSION: PaneId = 'simple-session'
/** The key the panes keep their memory of closed panes under. */
const CLOSED_KEY = 'closedPanes'

const placed = (id: PaneId, isShown = true): UiPane => ({ id, title: id, isShown, isFocused: false, isPlaced: true })

/** Lets the promise chains a call started run to their end. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 50; turn += 1) {
    await Promise.resolve()
  }
}

/** A Host for the panes alone: a store in memory, the panes the surface lists, and timers that fire when told to. */
function hostOf(store: Map<string, unknown> = new Map(), listed: UiPane[] = []) {
  const opens: PaneOpenArgs[] = []
  const closes: PaneCloseArgs[] = []
  const timers: (() => void)[] = []
  const host: Host = {
    root: '/plugin',
    now: async () => 0,
    after: (ms, fn) => {
      timers.push(fn)

      return { cancel: () => undefined }
    },
    every: () => ({ cancel: () => undefined }),
    cwd: async () => '/repo',
    model: async () => 'claude-opus-5-5',
    usage: async () => {
      throw new Error('not asked')
    },
    run: async () => {
      throw new Error('not asked')
    },
    nerdFont: async () => undefined,
    quietNetwork: async () => undefined,
    settings: async () => ({}),
    storeGet: async key => store.get(key),
    storeSet: async (key, value) => void store.set(key, value),
    invalidate: () => undefined,
    toast: () => undefined,
    log: () => undefined,
    openPane: async pane => {
      opens.push(pane)

      return { isPlaced: true }
    },
    closePane: async pane => {
      closes.push(pane)
    },
    panes: async () => listed,
    registerCommand: async () => ({}),
    runCommand: async () => ({}),
    copy: async () => ({}),
  }

  return { host, store, opens, closes, listed, fire: () => timers.splice(0).forEach(fn => fn()) }
}

/** Panes with their reports kept: which pane was reported shown or hidden, in order. */
function panesOf(isAutoOpen = false) {
  const shown: [PaneId, boolean][] = []
  const refreshes: number[] = []
  const panes = createPanes({
    isAutoOpen,
    onShown: (id, isOpen) => void shown.push([id, isOpen]),
    onRefresh: () => void refreshes.push(refreshes.length),
  })

  return { panes, shown, refreshes }
}

describe('/workbench arguments', () => {
  const both = PANES
  const only = (id: PaneId) => PANES.filter(pane => pane.id === id)

  test('name a pane, an action, both or neither, in any order and any case', () => {
    expect(parseArgs('')).toEqual({ panes: both, action: 'toggle' })
    expect(parseArgs('   ')).toEqual({ panes: both, action: 'toggle' })
    expect(parseArgs('work')).toEqual({ panes: only(WORK), action: 'toggle' })
    expect(parseArgs('session')).toEqual({ panes: only(SESSION), action: 'toggle' })
    expect(parseArgs('work session')).toEqual({ panes: both, action: 'toggle' })
    expect(parseArgs('open')).toEqual({ panes: both, action: 'open' })
    expect(parseArgs('close')).toEqual({ panes: both, action: 'close' })
    expect(parseArgs('refresh')).toEqual({ panes: both, action: 'refresh' })
    expect(parseArgs('toggle')).toEqual({ panes: both, action: 'toggle' })
    expect(parseArgs('session close')).toEqual({ panes: only(SESSION), action: 'close' })
    expect(parseArgs('close session')).toEqual({ panes: only(SESSION), action: 'close' })
    expect(parseArgs('  WORK   Open ')).toEqual({ panes: only(WORK), action: 'open' })
  })

  test('anything else is refused, so that a typo opens or closes nothing', () => {
    for (const args of ['nonsense', 'work nonsense', 'open close', 'work open close', 'refresh open', 'workbench']) {
      expect(parseArgs(args), args).toBeNull()
    }
  })

  test('are answered with the usage line, and touch no pane', async () => {
    const { host, opens, closes } = hostOf(new Map(), [placed(WORK), placed(SESSION)])
    const { panes } = panesOf()

    await panes.start(host)
    expect(await panes.run('nonsense')).toBe(USAGE)
    expect(await panes.run('open close')).toBe(USAGE)
    expect([opens, closes]).toEqual([[], []])
  })

  test('are answered before the panes are ready with a line saying so, not with an error', async () => {
    const { panes } = panesOf()

    expect(await panes.run('work')).toBe('The panes are not ready yet: try again in a moment.')
  })
})

describe('a pane the person closed by hand', () => {
  test('is remembered in the store, as the list of the ids closed', async () => {
    const { host, store } = hostOf(new Map(), [placed(WORK), placed(SESSION)])
    const { panes } = panesOf()

    await panes.start(host)
    expect(panes.isOpen(WORK)).toBe(true)
    panes.closed(WORK, true)
    await settle()
    expect(store.get(CLOSED_KEY)).toEqual([WORK])
    expect(panes.isOpen(WORK)).toBe(false)
    expect(panes.isOpen(SESSION)).toBe(true)
    panes.closed(SESSION, true)
    await settle()
    expect(store.get(CLOSED_KEY)).toEqual([WORK, SESSION])
  })

  test('is not remembered when the plugin closed it itself', async () => {
    const { host, store } = hostOf(new Map(), [placed(WORK)])
    const { panes, shown } = panesOf()

    await panes.start(host)
    panes.closed(WORK, false)
    await settle()
    expect(store.has(CLOSED_KEY)).toBe(false)
    // It is shut all the same: reported once, as it was reported open.
    expect(panes.isOpen(WORK)).toBe(false)
    expect(shown).toEqual([
      [WORK, true],
      [WORK, false],
    ])
  })

  test('is reported hidden once, however many times the engine says it closed', async () => {
    const { host } = hostOf(new Map(), [placed(WORK)])
    const { panes, shown } = panesOf()

    await panes.start(host)
    panes.closed(WORK, true)
    panes.closed(WORK, true)
    await settle()
    expect(shown).toEqual([
      [WORK, true],
      [WORK, false],
    ])
  })

  test("is ignored when it is not one of the plugin's two", async () => {
    const { host, store } = hostOf(new Map(), [placed(WORK)])
    const { panes, shown } = panesOf()

    await panes.start(host)
    panes.closed('somebody-elses', true)
    await settle()
    expect(store.has(CLOSED_KEY)).toBe(false)
    expect(shown).toEqual([[WORK, true]])
  })

  test('is not opened by itself in the next session, and the other pane is', async () => {
    // The first session: both panes are up, and the person closes Work.
    const first = hostOf(new Map(), [placed(WORK), placed(SESSION)])
    const before = panesOf(true)

    await before.panes.start(first.host)
    before.panes.closed(WORK, true)
    await settle()

    // The second session reads what the first left in the store, on a fullscreen terminal.
    const second = hostOf(first.store)
    const after = panesOf(true)

    await after.panes.start(second.host)
    after.panes.sawViewport(true)
    second.fire()
    await settle()
    expect(second.opens.map(pane => pane.id)).toEqual([SESSION])
  })

  test('is forgotten when the person opens it again with /workbench', async () => {
    const { host, store } = hostOf(new Map([[CLOSED_KEY, [WORK, SESSION]]]))
    const { panes } = panesOf()

    await panes.start(host)
    expect(await panes.run('work')).toBe('')
    expect(store.get(CLOSED_KEY)).toEqual([SESSION])
    expect(await panes.run('session open')).toBe('')
    expect(store.get(CLOSED_KEY)).toEqual([])
  })

  test('is read from the store as what it is: an id of the two panes, nothing else', async () => {
    const seeded = hostOf(new Map([[CLOSED_KEY, [SESSION, 'somebody-elses', 7, null]]]))
    const { panes } = panesOf(true)

    await panes.start(seeded.host)
    panes.sawViewport(true)
    seeded.fire()
    await settle()
    expect(seeded.opens.map(pane => pane.id)).toEqual([WORK])
    // What it writes back is the two panes' ids alone.
    panes.closed(WORK, true)
    await settle()
    expect(seeded.store.get(CLOSED_KEY)).toEqual([SESSION, WORK])

    // A store that holds something else under the key is no memory at all.
    const garbled = hostOf(new Map([[CLOSED_KEY, 'simple-work']]))
    const other = panesOf(true)

    await other.panes.start(garbled.host)
    other.panes.sawViewport(true)
    garbled.fire()
    await settle()
    expect(garbled.opens.map(pane => pane.id)).toEqual([WORK, SESSION])
  })
})

describe('the panes a surface lists', () => {
  test('that were left open by a reload are found again, those waiting for room are not counted', async () => {
    const waiting: UiPane = { ...placed(SESSION, false), isPlaced: false }
    const { host } = hostOf(new Map(), [placed(WORK), waiting])
    const { panes, shown } = panesOf()

    await panes.start(host)
    expect(panes.isOpen(WORK)).toBe(true)
    expect(panes.isOpen(SESSION)).toBe(false)
    expect(shown).toEqual([[WORK, true]])
  })

  test('are read again by sync: a pane placed once the terminal widens counts, one that vanished does not', async () => {
    const waiting: UiPane = { ...placed(WORK), isPlaced: false }
    const { host, listed } = hostOf(new Map(), [waiting, placed(SESSION)])
    const { panes, shown } = panesOf()

    await panes.start(host)
    expect(panes.isOpen(WORK)).toBe(false)
    expect(panes.isOpen(SESSION)).toBe(true)
    // Still waiting for room: still not open.
    await panes.sync()
    expect(panes.isOpen(WORK)).toBe(false)

    // The terminal is widened: Work is placed. A tab is closed from the surface's side: Session is gone.
    listed.splice(0, listed.length, placed(WORK))
    await panes.sync()
    expect(panes.isOpen(WORK)).toBe(true)
    expect(panes.isOpen(SESSION)).toBe(false)
    expect(shown).toEqual([
      [SESSION, true],
      [WORK, true],
      [SESSION, false],
    ])
    // Nothing changed since: nothing is reported again.
    await panes.sync()
    expect(shown.length).toBe(3)
  })

  test('are not read before the panes are started', async () => {
    const { panes, shown } = panesOf()

    await panes.sync()
    expect(shown).toEqual([])
  })
})

describe('/workbench refresh', () => {
  test('reads GitHub again and does nothing to the panes or to what was closed', async () => {
    const { host, store, opens, closes } = hostOf(new Map([[CLOSED_KEY, [WORK]]]), [placed(SESSION)])
    const { panes, refreshes } = panesOf()

    await panes.start(host)
    expect(await panes.run('refresh')).toBe('')
    expect(await panes.run('work refresh')).toBe('')
    expect(refreshes.length).toBe(2)
    expect([opens, closes]).toEqual([[], []])
    expect(store.get(CLOSED_KEY)).toEqual([WORK])
  })
})
