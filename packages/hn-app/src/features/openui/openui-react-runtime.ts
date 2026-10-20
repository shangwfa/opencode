import "./openui-commit.css"

import { createParser, type ElementNode, type ParseResult } from "@openuidev/lang-core"
import { Renderer, type ActionEvent, type ComponentRenderProps } from "@openuidev/react-lang"
import { Button as OpenUIButton, Card, ThemeProvider } from "@openuidev/react-ui"
import { openuiChatLibrary } from "@openuidev/react-ui/genui-lib"
import { createContext, createElement, useContext } from "react"
import { createRoot, type Root } from "react-dom/client"

export type OpenUIThemeMode = "light" | "dark"
export type OpenUICommitActionState = "hidden" | "disabled" | "enabled" | "committed"
export type OpenUIHostAction = { type: "commit_code"; commitMessage?: string }

export type OpenUIReactInput = {
  source: string
  cacheKey: string
  mode: OpenUIThemeMode
  streaming: boolean
  commitActionState?: OpenUICommitActionState
  onHostAction?: (action: OpenUIHostAction) => void
}

export type OpenUIRenderStatus = "rendered" | "incomplete" | "invalid" | "unsafe"

export type OpenUIReactController = {
  update(input: OpenUIReactInput): OpenUIRenderStatus
  unmount(): void
}

const parser = createParser(openuiChatLibrary.toJSONSchema(), "Card")
const stateCache = new Map<string, Record<string, unknown>>()
const stateCacheLimit = 200
const forbiddenCalls = new Set(["Query", "Mutation", "Run", "OpenUrl", "ToAssistant"])
const forbiddenActionTypes = new Set(["run", "open_url", "continue_conversation"])
let islandSequence = 0

const hostActionContext = createContext<OpenUICommitActionState>("hidden")
const officialButton = openuiChatLibrary.components.Button

type CommitActionResult =
  | { kind: "none" }
  | { kind: "valid"; commitMessage?: string }
  | { kind: "invalid" }

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function readCommitAction(value: unknown): CommitActionResult {
  if (!record(value) || value.type !== "commit_code") return { kind: "none" }
  if (Object.keys(value).some((key) => key !== "type" && key !== "params")) return { kind: "invalid" }
  if (value.params !== undefined && !record(value.params)) return { kind: "invalid" }

  const params = (value.params ?? {}) as Record<string, unknown>
  if (Object.keys(params).some((key) => key !== "commitMessage")) return { kind: "invalid" }
  const raw = params.commitMessage
  if (raw !== undefined && typeof raw !== "string") return { kind: "invalid" }
  const commitMessage = raw?.trim()
  if (commitMessage && (/\r|\n/.test(commitMessage) || commitMessage.length > 72)) return { kind: "invalid" }
  return { kind: "valid", commitMessage: commitMessage || undefined }
}

function HostButton(props: ComponentRenderProps<Record<string, unknown>>) {
  const state = useContext(hostActionContext)
  const commit = readCommitAction(props.props.action)
  if (commit.kind !== "valid") return createElement(officialButton.component, props)
  if (state === "hidden") return null
  const isCommitted = state === "committed"
  const label = isCommitted ? "✓ 已提交" : `✓ ${props.props.label ?? "提交代码"}`
  const button =
    state === "enabled"
      ? createElement(officialButton.component, {
          ...props,
          props: { ...props.props, label },
        })
      : createElement(
          OpenUIButton,
          {
            variant:
              props.props.variant === "secondary" || props.props.variant === "tertiary"
                ? props.props.variant
                : "primary",
            size:
              props.props.size === "extra-small" || props.props.size === "small" || props.props.size === "large"
                ? props.props.size
                : "medium",
            buttonType: props.props.type === "destructive" ? "destructive" : "normal",
            disabled: true,
          },
          label
        )
  // Black pill styling: host wrapper overrides primary variant via CSS
  return createElement(
    "span",
    {
      className: "openui-commit-wrapper",
      style: { display: "inline-flex" } as React.CSSProperties,
    },
    button,
  )
}

const hostOpenUILibrary = {
  ...openuiChatLibrary,
  components: {
    ...openuiChatLibrary.components,
    Button: { ...officialButton, component: HostButton },
  },
}

const fontBody = '"Inter", sans-serif'
const fontCode = '"SFMono-Regular", Consolas, "Liberation Mono", monospace'
const compactTypographyTheme = {
  fontSizeXs: "12px",
  fontSizeSm: "12px",
  fontSizeMd: "14px",
  fontSizeLg: "16px",
  fontSizeXl: "18px",
  textBodyXs: `400 12px/1.5 ${fontBody}`,
  textBodyXsHeavy: `500 12px/1.5 ${fontBody}`,
  textBodySm: `400 12px/1.5 ${fontBody}`,
  textBodySmHeavy: `500 12px/1.5 ${fontBody}`,
  textBodyDefault: `400 14px/1.5 ${fontBody}`,
  textBodyDefaultHeavy: `500 14px/1.5 ${fontBody}`,
  textBodyLg: `400 16px/1.5 ${fontBody}`,
  textBodyLgHeavy: `500 16px/1.5 ${fontBody}`,
  textHeadingXs: `600 15px/1.25 ${fontBody}`,
  textHeadingSm: `600 16px/1.25 ${fontBody}`,
  textHeadingMd: `600 20px/1.15 ${fontBody}`,
  textHeadingLg: `600 24px/1.15 ${fontBody}`,
  textHeadingXl: `700 28px/1.1 ${fontBody}`,
  textLabelXs: `400 12px/1.25 ${fontBody}`,
  textLabelXsHeavy: `500 12px/1.25 ${fontBody}`,
  textLabelSm: `400 12px/1.25 ${fontBody}`,
  textLabelSmHeavy: `500 12px/1.25 ${fontBody}`,
  textLabelDefault: `400 14px/1.25 ${fontBody}`,
  textLabelDefaultHeavy: `500 14px/1.25 ${fontBody}`,
  textLabelLg: `400 16px/1.25 ${fontBody}`,
  textLabelLgHeavy: `500 16px/1.25 ${fontBody}`,
  textNumbersXs: `400 12px/1.5 ${fontBody}`,
  textNumbersXsHeavy: `500 12px/1.5 ${fontBody}`,
  textNumbersSm: `400 12px/1.5 ${fontBody}`,
  textNumbersSmHeavy: `500 12px/1.5 ${fontBody}`,
  textNumbersDefault: `400 14px/1.5 ${fontBody}`,
  textNumbersDefaultHeavy: `500 14px/1.5 ${fontBody}`,
  textNumbersLg: `400 16px/1.5 ${fontBody}`,
  textNumbersLgHeavy: `500 16px/1.5 ${fontBody}`,
  textNumbersHeadingSm: `600 16px/1.25 ${fontBody}`,
  textCodeSm: `400 12px/1.5 ${fontCode}`,
  textCodeSmHeavy: `700 12px/1.5 ${fontCode}`,
  textCodeDefault: `400 13px/1.5 ${fontCode}`,
  textCodeDefaultHeavy: `700 13px/1.5 ${fontCode}`,
} as const

function cacheState(key: string, state: Record<string, unknown>) {
  stateCache.delete(key)
  stateCache.set(key, state)
  if (stateCache.size <= stateCacheLimit) return
  const oldest = stateCache.keys().next().value
  if (oldest) stateCache.delete(oldest)
}

function containsForbiddenAction(value: unknown, seen = new Set<object>()): boolean {
  if (!value || typeof value !== "object") return false
  if (seen.has(value)) return false
  seen.add(value)

  if (Array.isArray(value)) return value.some((item) => containsForbiddenAction(item, seen))

  const record = value as Record<string, unknown>
  if (record.k === "Comp" && typeof record.name === "string" && forbiddenCalls.has(record.name)) return true
  if (typeof record.type === "string" && forbiddenActionTypes.has(record.type)) return true
  return Object.values(record).some((item) => containsForbiddenAction(item, seen))
}

function inspectHostActions(value: unknown, seen = new Set<object>()): { unsafe: boolean; commits: number } {
  if (!value || typeof value !== "object") return { unsafe: false, commits: 0 }
  if (seen.has(value)) return { unsafe: false, commits: 0 }
  seen.add(value)
  if (Array.isArray(value)) {
    return value.reduce(
      (result, item) => {
        const next = inspectHostActions(item, seen)
        return { unsafe: result.unsafe || next.unsafe, commits: result.commits + next.commits }
      },
      { unsafe: false, commits: 0 },
    )
  }

  const current = value as Record<string, unknown>
  let unsafe = false
  let commits = 0
  if (current.type === "element" && record(current.props) && "action" in current.props) {
    const action = current.props.action
    const commit = readCommitAction(action)
    if (commit.kind === "valid") {
      if (current.typeName !== "Button") unsafe = true
      else commits += 1
    }
    else if (commit.kind === "invalid" || (record(action) && action.k !== "Comp")) unsafe = true
  }
  for (const item of Object.values(current)) {
    const next = inspectHostActions(item, seen)
    unsafe ||= next.unsafe
    commits += next.commits
  }
  return { unsafe, commits }
}

function hostActionFromEvent(event: ActionEvent): OpenUIHostAction | undefined {
  const commit = readCommitAction({ type: event.type, params: event.params })
  if (commit.kind !== "valid") return
  return { type: "commit_code", commitMessage: commit.commitMessage }
}

function hasResolvedCardContent(root: ElementNode) {
  if (!record(root.props)) return false
  const children = root.props.children
  return Array.isArray(children) && children.length > 0
}

export function inspectOpenUI(source: string, streaming: boolean): OpenUIRenderStatus {
  try {
    const result: ParseResult = parser.parse(source)
    if (result.queryStatements.length || result.mutationStatements.length) return "unsafe"
    if (result.root && containsForbiddenAction(result.root as ElementNode)) return "unsafe"
    const hostActions = inspectHostActions(result.root)
    if (hostActions.unsafe || hostActions.commits > 1) return "unsafe"
    if (!result.root) return streaming ? "incomplete" : "invalid"
    if (result.root.typeName !== "Card") return "invalid"

    const invalidFinal =
      result.meta.incomplete ||
      result.meta.orphaned.length > 0 ||
      result.meta.errors.length > 0 ||
      (result.meta.unresolved.length > 0 && !hasResolvedCardContent(result.root as ElementNode))
    if (!streaming && invalidFinal) return "invalid"
    return "rendered"
  } catch {
    return streaming ? "incomplete" : "invalid"
  }
}

function collectCommitActions(value: unknown, actions: OpenUIHostAction[], seen = new Set<object>()) {
  if (!value || typeof value !== "object" || seen.has(value)) return
  seen.add(value)
  if (Array.isArray(value)) {
    value.forEach((item) => collectCommitActions(item, actions, seen))
    return
  }

  const current = value as Record<string, unknown>
  if (current.type === "element" && current.typeName === "Button" && record(current.props)) {
    const commit = readCommitAction(current.props.action)
    if (commit.kind === "valid") {
      actions.push({ type: "commit_code", commitMessage: commit.commitMessage })
    }
  }
  Object.values(current).forEach((item) => collectCommitActions(item, actions, seen))
}

/** Returns the single safe host commit action embedded in a complete OpenUI program. */
export function extractOpenUICommitAction(source: string): OpenUIHostAction | undefined {
  if (inspectOpenUI(source, false) !== "rendered") return
  try {
    const result: ParseResult = parser.parse(source)
    const actions: OpenUIHostAction[] = []
    collectCommitActions(result.root, actions)
    return actions.length === 1 ? actions[0] : undefined
  } catch {
    return
  }
}

function bindTabsIndicatorFix(host: HTMLElement): () => void {
  const cleanups: Array<() => void> = []

  const syncContainer = (container: HTMLElement, animated: boolean) => {
    const list = container.querySelector<HTMLElement>(".openui-tabs-list")
    const indicator = container.querySelector<HTMLElement>(".openui-tabs-indicator")
    if (!list || !indicator) return
    const active = list.querySelector<HTMLElement>('[role="tab"][data-state="active"]')
    if (!active) return
    const left = active.offsetLeft - list.scrollLeft
    const width = active.offsetWidth
    if (width === 0) return
    indicator.style.transition = animated
      ? "transform 0.25s cubic-bezier(0.4, 0, 0.2, 1), width 0.25s cubic-bezier(0.4, 0, 0.2, 1)"
      : "none"
    indicator.style.width = `${width}px`
    indicator.style.transform = `translateX(${left}px)`
    indicator.style.opacity = "1"
  }

  const syncAll = (animated: boolean) => {
    host.querySelectorAll<HTMLElement>(".openui-tabs-list-container").forEach((c) => syncContainer(c, animated))
  }

  const attach = () => {
    const containers = Array.from(host.querySelectorAll<HTMLElement>(".openui-tabs-list-container"))
    if (containers.length === 0) return

    for (const container of containers) {
      const list = container.querySelector<HTMLElement>(".openui-tabs-list")
      if (!list) continue

      // Initial sync after layout settles (rAF x2 covers font / flex)
      const raf1 = requestAnimationFrame(() => syncContainer(container, false))
      const raf2 = requestAnimationFrame(() => requestAnimationFrame(() => syncContainer(container, false)))
      cleanups.push(() => cancelAnimationFrame(raf1), () => cancelAnimationFrame(raf2))

      // Fonts ready can change trigger width
      if (typeof document !== "undefined" && (document as unknown as { fonts?: { ready: Promise<void> } }).fonts?.ready) {
        void (document as unknown as { fonts: { ready: Promise<void> } }).fonts.ready.then(() => syncContainer(container, false))
      }

      // Active tab changes via data-state
      const mo = new MutationObserver(() => syncContainer(container, true))
      mo.observe(list, { attributes: true, subtree: true, attributeFilter: ["data-state"] })
      cleanups.push(() => mo.disconnect())

      // List width / scrollLeft
      const roList = new ResizeObserver(() => syncContainer(container, false))
      roList.observe(list)
      cleanups.push(() => roList.disconnect())

      // Each trigger width may change (Inter font, content)
      const triggers = Array.from(list.querySelectorAll<HTMLElement>('[role="tab"]'))
      const roTabs = new ResizeObserver(() => syncContainer(container, false))
      triggers.forEach((t) => roTabs.observe(t))
      cleanups.push(() => roTabs.disconnect())

      const onScroll = () => syncContainer(container, false)
      list.addEventListener("scroll", onScroll)
      cleanups.push(() => list.removeEventListener("scroll", onScroll))

      // TabsList's smooth center-scroll animates scrollLeft; keep indicator in sync during animation
      const onClick = () => {
        let frames = 24
        const tick = () => {
          syncContainer(container, false)
          if (--frames > 0) requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      }
      list.addEventListener("click", onClick)
      cleanups.push(() => list.removeEventListener("click", onClick))
    }

    // Visibility: content-visibility:auto / display:none initial measure was 0
    if (typeof IntersectionObserver !== "undefined") {
      const io = new IntersectionObserver((entries) => {
        for (const e of entries) if (e.isIntersecting) syncAll(false)
      })
      io.observe(host)
      cleanups.push(() => io.disconnect())
    }

    if (typeof ResizeObserver !== "undefined") {
      const roHost = new ResizeObserver(() => syncAll(false))
      roHost.observe(host)
      cleanups.push(() => roHost.disconnect())
    }

    const onWinResize = () => syncAll(false)
    window.addEventListener("resize", onWinResize)
    cleanups.push(() => window.removeEventListener("resize", onWinResize))
  }

  // Defer to after React committed
  const timer = window.setTimeout(attach, 0)
  cleanups.push(() => window.clearTimeout(timer))

  // Mutation on host (Tabs can be streamed in later)
  const hostMo = new MutationObserver(() => {
    // Re-attach if new containers appear; simple re-sync covers it
    syncAll(false)
  })
  hostMo.observe(host, { childList: true, subtree: true })
  cleanups.push(() => hostMo.disconnect())

  return () => cleanups.forEach((fn) => fn())
}

export function mountOpenUIReact(host: HTMLElement, input: OpenUIReactInput): OpenUIReactController {
  const root: Root = createRoot(host)
  const id = `openui-react-island-${++islandSequence}`
  let hasRendered = false
  host.id = id
  let tabsCleanup: (() => void) | undefined

  const scheduleTabsFix = () => {
    tabsCleanup?.()
    tabsCleanup = bindTabsIndicatorFix(host)
  }

  const update = (next: OpenUIReactInput): OpenUIRenderStatus => {
    const status = inspectOpenUI(next.source, next.streaming)
    if (status !== "rendered") {
      // A streaming delta can temporarily end in the middle of a declaration.
      // Keep the last valid tree mounted so the message height does not collapse
      // and force the conversation viewport to jump before the next delta arrives.
      if (hasRendered && next.streaming && status === "incomplete") return "rendered"
      root.render(null)
      hasRendered = false
      tabsCleanup?.()
      tabsCleanup = undefined
      return status
    }

    root.render(
      createElement(
        ThemeProvider,
        {
          mode: next.mode,
          cssSelector: `#${id}`,
          lightTheme: compactTypographyTheme,
          darkTheme: compactTypographyTheme,
        },
        createElement(
          Card,
          {
            variant: "card",
            width: "full",
            className: "openui-message-frame",
            style: {
              width: "100%",
              maxWidth: "100%",
              minWidth: 0,
              height: "auto",
              maxHeight: "none",
              overflow: "visible",
              padding: "clamp(12px, 2vw, 16px)",
              borderColor: "var(--openui-border-default)",
              borderRadius: "var(--openui-radius-3xl)",
              background: "var(--openui-foreground)",
            },
          },
          createElement(
            hostActionContext.Provider,
            { value: next.commitActionState ?? "hidden" },
            createElement(Renderer, {
              response: next.source,
              library: hostOpenUILibrary,
              isStreaming: next.streaming,
              initialState: stateCache.get(next.cacheKey),
              onStateUpdate: (state: Record<string, unknown>) => cacheState(next.cacheKey, state),
              onAction: (event: ActionEvent) => {
                if ((next.commitActionState ?? "hidden") !== "enabled") return
                const action = hostActionFromEvent(event)
                if (action) next.onHostAction?.(action)
              },
              toolProvider: null,
              publishObservability: false,
            }),
          ),
        ),
      ),
    )
    hasRendered = true
    // Tabs indicator measures offsetLeft/offsetWidth after commit; schedule after paint
    requestAnimationFrame(() => scheduleTabsFix())
    return status
  }

  update(input)
  return {
    update,
    unmount() {
      tabsCleanup?.()
      root.unmount()
      host.removeAttribute("id")
    },
  }
}
