// The side panes: Work and Session, two native tabs of one sidebar. They open
// from /workbench at any width; by themselves only when the person turned
// that on, once per session, where they are a sidebar (a fullscreen terminal),
// and never again after the person closed them until they open them.

import type { Host } from './host'

export type PaneId = 'simple-work' | 'simple-session'

export type PaneSpec = { id: PaneId; title: string; arg: string }

export const PANES: readonly PaneSpec[] = [
  { id: 'simple-work', title: 'Work', arg: 'work' },
  { id: 'simple-session', title: 'Session', arg: 'session' },
]

export const USAGE = 'Usage: /workbench [work|session] [open|close|refresh]'

const CLOSED_KEY = 'closedPanes'

/** What /workbench was asked: which panes, and what to do with them. */
export function parseArgs(args: string): { panes: readonly PaneSpec[]; action: 'toggle' | 'open' | 'close' | 'refresh' } | null {
  const words = args.trim().toLowerCase().split(/\s+/).filter(word => word !== '')
  const named = PANES.filter(pane => words.includes(pane.arg))
  const actions = words.filter(word => !PANES.some(pane => pane.arg === word))
  const action = actions[0] ?? 'toggle'

  if (actions.length > 1 || !['toggle', 'open', 'close', 'refresh'].includes(action)) {
    return null
  }

  return { panes: named.length > 0 ? named : PANES, action: action as 'toggle' | 'open' | 'close' | 'refresh' }
}

export function createPanes(options: { isAutoOpen: boolean; onShown: (id: PaneId, isOpen: boolean) => void; onRefresh: () => void }) {
  let host: Host | null = null
  let isReady = false
  let hasAutoOpened = false
  let isFullscreen: boolean | undefined
  let closedByPerson = new Set<PaneId>()
  const open = new Set<PaneId>()

  function noteOpen(id: PaneId, isOpen: boolean): void {
    if (isOpen !== open.has(id)) {
      if (isOpen) {
        open.add(id)
      } else {
        open.delete(id)
      }
      options.onShown(id, isOpen)
    }
  }

  async function remember(bound: Host): Promise<void> {
    await bound.storeSet(CLOSED_KEY, [...closedByPerson])
  }

  async function openOne(bound: Host, pane: PaneSpec, isRaised: boolean): Promise<string> {
    const placed = await bound.openPane({ id: pane.id, title: pane.title, ...(isRaised ? { focus: true as const } : {}) })

    // A pane waiting for room is open but not on screen: it counts once the surface places it (sync).
    noteOpen(pane.id, placed.isPlaced)

    return placed.isPlaced ? '' : `The ${pane.title} pane waits: ${placed.reason}`
  }

  /** Closes a pane the person asked to close: recorded before the close, which reaches hooks as the plugin's. */
  async function closeOne(bound: Host, pane: PaneSpec): Promise<void> {
    closedByPerson.add(pane.id)
    await remember(bound)
    await bound.closePane({ id: pane.id })
    noteOpen(pane.id, false)
  }

  /** The unasked open: once, only where a pane is a sidebar, never after a close by hand. */
  function tryAutoOpen(): void {
    const bound = host

    if (bound === null || !isReady || hasAutoOpened || !options.isAutoOpen || isFullscreen !== true) {
      return
    }
    hasAutoOpened = true
    for (const pane of PANES) {
      if (!closedByPerson.has(pane.id) && !open.has(pane.id)) {
        void bound.openPane({ id: pane.id, title: pane.title }).then(
          placed => noteOpen(pane.id, placed.isPlaced),
          error => bound.log(`panes: open ${pane.id}: ${String(error)}`),
        )
      }
    }
  }

  return {
    /** Binds the engine; panes a reload left open are found again. */
    async start(bound: Host): Promise<void> {
      if (host !== null) {
        return
      }
      host = bound

      const [stored, already] = await Promise.all([bound.storeGet(CLOSED_KEY), bound.panes()])

      closedByPerson = new Set(
        Array.isArray(stored) ? stored.filter((id): id is PaneId => PANES.some(pane => pane.id === id)) : [],
      )
      for (const pane of already) {
        const spec = PANES.find(one => one.id === pane.id)

        if (spec !== undefined) {
          noteOpen(spec.id, pane.isPlaced)
        }
      }
      isReady = true
      tryAutoOpen()
    },

    /** Whether the pane is open and placed on screen (shown, or a tab beside the shown one). */
    isOpen(id: PaneId): boolean {
      return open.has(id)
    },

    /** Reads which panes the surface has placed: one waiting for room is placed once the terminal widens. */
    async sync(): Promise<void> {
      const bound = host

      if (bound === null) {
        return
      }

      const listed = await bound.panes()

      for (const pane of PANES) {
        noteOpen(pane.id, listed.some(one => one.id === pane.id && one.isPlaced))
      }
    },

    /** The last terminal drawing's layout; the open itself runs off the drawing, on a timer. */
    sawViewport(fullscreen: boolean | undefined): void {
      if (fullscreen !== undefined && fullscreen !== isFullscreen) {
        isFullscreen = fullscreen
        host?.after(50, tryAutoOpen)
      }
    },

    /**
     * /workbench [work|session] [open|close|refresh]. A toggle closes only
     * panes the person can see; one waiting for room or behind another tab is
     * opened, or raised, instead. Asked, a pane is placed at any width.
     */
    async run(args: string): Promise<string> {
      const bound = host
      const asked = parseArgs(args)

      if (bound === null) {
        return 'The panes are not ready yet: try again in a moment.'
      }
      if (asked === null) {
        return USAGE
      }
      // A refresh reads GitHub again; it opens nothing and forgets nothing.
      if (asked.action === 'refresh') {
        options.onRefresh()

        return ''
      }

      const listed = await bound.panes()
      const stateOf = (id: PaneId) => listed.find(pane => pane.id === id)
      const isSeen = (id: PaneId) => {
        const pane = stateOf(id)

        return pane !== undefined && pane.isPlaced && pane.isShown
      }
      const isClosing = asked.action === 'close' || (asked.action === 'toggle' && asked.panes.some(pane => isSeen(pane.id)))
      const notes: string[] = []

      for (const pane of asked.panes) {
        if (isClosing) {
          if (stateOf(pane.id) !== undefined) {
            await closeOne(bound, pane)
          }
        } else {
          closedByPerson.delete(pane.id)
          // An open pane behind another tab is raised; a new one opens where the surface places it.
          const note = await openOne(bound, pane, stateOf(pane.id) !== undefined && !isSeen(pane.id))

          if (note !== '') {
            notes.push(note)
          }
        }
      }
      if (!isClosing) {
        await remember(bound)
      }

      return notes.join('\n')
    },

    /** A pane closed. By the person's mark or key, it stays closed in later sessions. */
    closed(id: string, isByPerson: boolean): void {
      const pane = PANES.find(one => one.id === id)

      if (pane === undefined) {
        return
      }
      noteOpen(pane.id, false)
      if (isByPerson && host !== null) {
        closedByPerson.add(pane.id)
        void remember(host).catch(() => undefined)
      }
    },
  }
}

export type Panes = ReturnType<typeof createPanes>
