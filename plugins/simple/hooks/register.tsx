// The plugin's hooks module: the status line under the prompt (or in the band
// above it) and two side panes, Work and Session. This file binds the engine
// (`hostOf`) and wires its events to the lanes (lanes.ts), the session log
// (session-log.ts) and the panes (panes.ts); it is the only file that touches `$`.

import type {
  ButtonProps,
  Color,
  ElementConstructor,
  EngineInterface,
  On,
  PluginOptions,
  RenderElement,
  RenderSurface,
  TextProps,
  BoxProps,
} from 'claude-code'

import type { Host } from './host'
import { createLanes } from './lanes'
import { createPanes } from './panes'
import { createSessionLog } from './session-log'
import type { Row, Span, Tone } from './statusline-format'
import { sessionView } from './views/session'
import { workView } from './views/work'

const COLORS: Record<Tone, Color> = {
  ok: 'success',
  warn: 'warning',
  bad: 'error',
  muted: 'inactive',
  path: 'blue',
  branch: 'magenta',
  link: 'cyan',
}
const SEPARATOR = ' │ '
/** The tools whose call can change the working tree or move the session to another one. */
const WRITE_TOOLS: ReadonlySet<string> = new Set(['Bash', 'Edit', 'Write', 'NotebookEdit', 'EnterWorktree', 'ExitWorktree'])
const WORKBENCH_HELP = 'Show or hide the side panes: Work (ticket, pull request, CI, team) and Session (MCP calls, agents, permissions, log)'
/** While something runs, the panes' clocks tick this often. */
const CLOCK_MS = 1000
/** Every fifth clock tick, which panes are placed is read again (a terminal widened, a tab closed). */
const PANES_SYNC_TICKS = 5

/** Whether a surface draws the status line: PromptHint and AbovePrompt are raised on these two only. */
function isLineSurface(surface: RenderSurface): boolean {
  return surface === 'terminal' || surface === 'desktop'
}

/**
 * Binds a Host from `$`. Declared in this file, each member spelled
 * `$.noun.event(...)`, so the engine reads what the module calls off its source.
 */
function hostOf($: EngineInterface): Host {
  return {
    root: $.plugin.root,
    now: () => $.clock.now(),
    after: (ms, fn) => $.clock.after(ms, fn),
    every: (ms, fn) => $.clock.every(ms, fn),
    cwd: () => $.session.cwd(),
    model: () => $.session.model(),
    usage: args => $.session.usage(args),
    run: (argv, init) => $.process.run(argv, init),
    nerdFont: () => $.env.get('STATUSLINE_NERD'),
    quietNetwork: () => $.env.get('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'),
    settings: () => $.settings.read(),
    storeGet: key => $.store.get(key),
    storeSet: (key, value) => $.store.set(key, value),
    invalidate: () => $.ui.invalidate('ui.render'),
    toast: (text, timeoutMs) => $.ui.toast(text, timeoutMs === undefined ? undefined : { timeoutMs }),
    log: text => $.ui.log(text, { to: 'debug' }),
    openPane: pane => $.ui.open(pane),
    closePane: pane => $.ui.close(pane),
    panes: () => $.ui.panes(),
    registerCommand: spec => $.command.register(spec),
    runCommand: command => $.command.run({ command }),
    copy: text => $.ui.copy({ text }),
  }
}

/** Characters a drawn text may not hold (C0 and C1 controls, DEL): one in a branch or folder name would make the engine refuse the whole row. */
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g

function styleOf(span: Span): TextProps {
  return {
    ...(span.tone === undefined ? {} : { color: COLORS[span.tone] }),
    ...(span.isBold === true ? { bold: true } : {}),
  }
}

type RowKit = {
  Box: ElementConstructor<BoxProps>
  Text: ElementConstructor<TextProps>
  Button: ElementConstructor<ButtonProps>
}

/**
 * One row: its segments' spans as nested Text, cut with an ellipsis where the
 * row ends. A span that presses (⟲ compact) is a Button, so its row is a Box
 * of the text before it, the button, and the text after it.
 */
function lineOf({ Box, Text, Button }: RowKit, row: Row, index: number, onPress: () => void): RenderElement {
  const spans = row.flatMap((segment, index) => [
    ...(index > 0 ? [{ text: SEPARATOR, tone: 'muted' as const }] : []),
    ...segment,
  ])
  const at = spans.findIndex(span => span.press !== undefined)
  const textOf = (part: Span[]) => (
    <Text wrap="truncate-end">
      {part.map(span => (
        <Text {...styleOf(span)}>{span.text.replace(CONTROLS, '')}</Text>
      ))}
    </Text>
  )

  const key = `status-row-${index + 1}`

  if (at < 0) {
    return <Box key={key}>{textOf(spans)}</Box>
  }

  const pressed = spans[at] as Span

  return (
    <Box key={key} flexDirection="row">
      {textOf(spans.slice(0, at))}
      <Button key="compact" label={pressed.text.replace(CONTROLS, '')} plain {...(pressed.tone === 'warn' ? {} : { dimColor: true })} onPress={onPress} />
      {textOf(spans.slice(at + 1))}
    </Box>
  )
}

export function register(on: On, options: PluginOptions): void {
  const hasStatusLine = options.statusline !== false
  const hasPanes = options.workbench !== false

  if (!hasStatusLine && !hasPanes) {
    return
  }

  const lanes = createLanes({
    hasStatusLine,
    hasWeekly: hasStatusLine && options.statuslineWeekly !== false,
    hasPr: hasStatusLine && options.statuslinePr !== false,
    hasWork: hasPanes,
  })
  const log = createSessionLog()
  const panes = createPanes({
    isAutoOpen: hasPanes && options.workbenchAutoOpen === true,
    onShown: (id, isOpen) => {
      if (id === 'simple-work') {
        lanes.workShown(isOpen)
      }
    },
    onRefresh: () => lanes.refreshGithub(),
  })
  let expanded: string | null = null
  let clock: { cancel: () => void } | null = null
  let ticks = 0
  let callCount = 0
  /** Whether /workbench was registered by this plugin: another may hold the name. */
  let isCommandOurs = false

  /** `drawsLine`: the surface draws the status line (PromptHint and AbovePrompt); every surface may place a pane. */
  function startAll(host: Host, drawsLine: boolean): void {
    if (drawsLine) {
      lanes.lineSeen()
    }
    lanes.start(host)
    if (hasPanes && clock === null) {
      // A name a built-in or another plugin holds is refused: the panes then open from /config only.
      void host
        .registerCommand({ name: 'workbench', description: WORKBENCH_HELP, argumentHint: '[work|session] [open|close|refresh]', immediate: true })
        .then(
          () => {
            isCommandOurs = true
          },
          error => host.log(`panes: /workbench is not ours: ${String(error)}`),
        )
      void panes.start(host).catch(error => host.log(`panes: start: ${String(error)}`))
      // Which panes are placed, as the surface lays them out; then the running clocks of what is on screen.
      clock = host.every(CLOCK_MS, () => {
        ticks += 1
        if (ticks % PANES_SYNC_TICKS === 0) {
          void panes.sync().catch(() => undefined)
        }
        if (lanes.isBusy() || (panes.isOpen('simple-session') && log.isBusy())) {
          host.invalidate()
        }
      })
    }
  }

  on('session.start', async ($, e, next) => {
    // Nothing draws in a -p or SDK run. The desktop app's clients arrive by session.attach, and after a
    // reload, when no client attaches again, the surfaces already attached say a drawing is there.
    const surfaces = e.isInteractive ? [] : await $.session.surfaces().catch(() => [])

    if (e.isInteractive || surfaces.length > 0) {
      startAll(hostOf($), e.isInteractive || surfaces.some(isLineSurface))
    }

    return next(e)
  })

  on('session.attach', async ($, e, next) => {
    startAll(hostOf($), isLineSurface(e.surface))

    return next(e)
  })

  on('classic.SessionStart', async ($, e, next) => {
    lanes.sessionStarted(e.source, e.agent_type, e.agent_id === undefined)
    if (e.source === 'clear' || e.source === 'resume') {
      log.reset()
      expanded = null
      $.ui.invalidate('ui.render')
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.Stop', async ($, e, next) => {
    if (e.agent_id === undefined) {
      lanes.effortSeen(e.effort?.level)
    }
    lanes.turnStopped(e.agent_type, e.agent_id === undefined)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.PostModelSwitch', async ($, e, next) => {
    lanes.windowChanged()

    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.ConfigChange', async ($, e, next) => {
    lanes.windowChanged()

    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.PostCompact', async ($, e, next) => {
    lanes.compacted()
    log.compacted({ trigger: e.trigger, nowMs: lanes.now() })
    $.ui.invalidate('ui.render')

    return next(e)
  }).catch(($, e, next) => next(e))

  // An MCP call's own duration, without the permission prompt or hooks, for the Session pane's timings.
  on('classic.PostToolUse', { tool_name: /^mcp__/ }, async ($, e, next) => {
    if (e.duration_ms !== undefined) {
      log.mcpTimed({ id: e.tool_use_id, ms: e.duration_ms })
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.PostToolUseFailure', { tool_name: /^mcp__/ }, async ($, e, next) => {
    if (e.duration_ms !== undefined) {
      log.mcpTimed({ id: e.tool_use_id, ms: e.duration_ms })
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.measure', async ($, e, next) => {
    lanes.measured()

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    const costUsd = (await $.session.usage().catch(() => null))?.cost?.usd ?? null

    log.turnStarted({ text: e.text, nowMs: lanes.now(), costUsd })
    $.ui.invalidate('ui.render')

    return next(e)
  })

  // Each model request: the main loop's effort, and a subagent's steps and tokens for its card.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      lanes.effortSeen(e.effort)

      return yield* next(e)
    }

    const result = yield* next(e)

    log.agentStepped({ agentId: e.agentId, usage: result.usage, stopReason: result.stopReason, nowMs: lanes.now() })
    $.ui.invalidate('ui.render')

    return result
  })

  on('turn.complete', async ($, e, next) => {
    const isMain = e.agentId === undefined
    const costUsd = isMain ? ((await $.session.usage().catch(() => null))?.cost?.usd ?? null) : null

    lanes.turnCompleted(e.usage, isMain)
    log.turnCompleted({ agentId: e.agentId, reason: e.reason, answer: e.answer, durationMs: e.durationMs, costUsd, nowMs: lanes.now() })
    $.ui.invalidate('ui.render')

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.turnId === undefined) {
      lanes.promptSent()
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)

    if (started.deny === undefined && started.agentId !== undefined) {
      log.agentSpawned({ id: started.agentId, type: e.name ?? e.subagentType, description: e.description, model: started.model, nowMs: lanes.now() })
      $.ui.invalidate('ui.render')
    }

    return started
  }).catch(($, e, next) => next(e))

  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)

    if (e.tool_use_id !== undefined) {
      log.toolChecked({ id: e.tool_use_id, tool: e.tool, input: e.input, decision: verdict.decision, agentId: e.agentId, nowMs: lanes.now() })
      $.ui.invalidate('ui.render')
    }

    return verdict
  }).catch(($, e, next) => next(e))

  // Every call: the Session pane counts tools, times MCP servers and follows agents.
  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const id = e.tool_use_id ?? `call-${(callCount += 1)}`
    // The tool's own arguments: the event carries them beside its envelope (the tool, the call's id, the loop).
    const { tool: _tool, tool_use_id: _id, agentId: _agent, ...input } = e as unknown as Readonly<Record<string, unknown>>

    log.toolStarted({ id, tool, agentId: e.agentId, input, nowMs: lanes.now() })

    const ran = await next(e)
    const isDenied = ran.deny !== undefined
    const isError = !isDenied && ran.isError === true

    log.toolFinished({ id, tool, agentId: e.agentId, input, isError, isDenied, result: ran.result, nowMs: lanes.now() })
    lanes.toolRan(WRITE_TOOLS.has(tool) && !isDenied && !isError && ran.isReadOnly !== true, ran.result)
    $.ui.invalidate('ui.render')

    return ran
  }).catch(($, e, next) => next(e))

  if (hasPanes) {
    on('command.run', { command: 'workbench' }, async ($, e, next) => {
      if (!isCommandOurs) {
        return next(e)
      }

      const text = await panes.run(e.args)

      return text === '' ? {} : { text }
    }).catch(($, e, next) => (next.called ? next(e) : { text: 'The side panes could not open: see the debug log.' }))

    on('ui.close', { id: ['simple-work', 'simple-session'] }, async ($, e, next) => {
      const closed = await next(e)

      panes.closed(e.id, e.origin.kind === 'person')

      return closed
    }).catch(($, e, next) => next(e))

    on('ui.render', { component: 'Pane', requestId: 'simple-work' }, async ($, e) => {
      const { Box, Text, Button } = $.ui.resolve(e)

      return workView({ Box, Text, Button }, lanes.work(), {
        nowMs: lanes.now(),
        width: e.props.bodyColumns,
        onRefresh: () => lanes.refreshGithub(),
        onCopy: url => {
          void $.ui.copy({ text: url, surface: e.surface }).then(
            copied => $.ui.toast(copied.isCopied ? 'Link copied' : `Could not copy the link: ${copied.reason}`),
            () => $.ui.toast('Could not copy the link'),
          )
        },
      })
    })

    on('ui.render', { component: 'Pane', requestId: 'simple-session' }, async ($, e) => {
      const { Box, Text, Button } = $.ui.resolve(e)

      return sessionView({ Box, Text, Button }, log.view(lanes.now()), {
        nowMs: lanes.now(),
        width: e.props.bodyColumns,
        expanded,
        onExpand: id => {
          expanded = id
          $.ui.invalidate('ui.render')
        },
      })
    })
  }

  if (options.statuslineAbovePrompt === true) {
    on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
      const rows = lanes.rows(lanes.now())

      panes.sawViewport(e.surface === 'terminal' ? e.viewport?.isFullscreen : undefined)
      if (e.props.hasSurvey || rows.length === 0) {
        return next(e)
      }

      const { Box, Text, Button } = $.ui.resolve(e)
      const below = await next(e)

      return (
        <Box flexDirection="column">
          {rows.map((row, index) => lineOf({ Box, Text, Button }, row, index, () => lanes.pressCompact()))}
          {below}
        </Box>
      )
    })
  } else {
    on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
      const rows = lanes.rows(lanes.now())
      const engine = await next(e)

      panes.sawViewport(e.surface === 'terminal' ? e.viewport?.isFullscreen : undefined)
      if (rows.length === 0) {
        return engine
      }

      const { Box, Text, Button } = $.ui.resolve(e)

      return (
        <Box flexDirection="column">
          {engine}
          {rows.map((row, index) => lineOf({ Box, Text, Button }, row, index, () => lanes.pressCompact()))}
        </Box>
      )
    })
  }
}

