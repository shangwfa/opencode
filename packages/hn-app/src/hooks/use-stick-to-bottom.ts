import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { bottomScrollTop, hasOverflow, isNearBottom, type ScrollMetrics } from "@/shared/util/auto-scroll"

/** 从节点向上找到最近的纵向可滚动祖先（时间线被放在不同页面的滚动容器里）。 */
function findScrollParent(node: HTMLElement | null): HTMLElement | null {
  let current = node?.parentElement ?? null
  while (current) {
    const style = getComputedStyle(current)
    const scrollable = /(auto|scroll|overlay)/.test(style.overflowY)
    // Radix 初次提交时可能还是 overflow:hidden，但它始终是同一个滚动 viewport。
    if (current.matches('[data-slot="scroll-area-viewport"]') || scrollable) return current
    current = current.parentElement
  }
  return null
}

const metricsOf = (el: HTMLElement): ScrollMetrics => ({
  scrollTop: el.scrollTop,
  scrollHeight: el.scrollHeight,
  clientHeight: el.clientHeight,
})

/**
 * stick-to-bottom：内容变化时只在「用户贴着底部」的情况下跟随；
 * 用户上滚后停止跟随，并暴露 `pinned=false` 供「回到底部」入口使用。
 */
export function useStickToBottom(deps: unknown[]) {
  const anchorRef = useRef<HTMLDivElement>(null)
  const [pinned, setPinned] = useState(true)
  const [overflowing, setOverflowing] = useState(false)
  const pinnedRef = useRef(true)
  const previousTop = useRef(0)

  const measure = useCallback(() => {
    const anchor = anchorRef.current
    const scroller = anchor ? findScrollParent(anchor) : null
    if (!scroller) return
    // 内容收起也会让 scrollTop 减小；不能把浏览器的底部夹取误判为用户上滚。
    const next = isNearBottom(metricsOf(scroller), 1) || (pinnedRef.current && scroller.scrollTop >= previousTop.current)
    previousTop.current = scroller.scrollTop
    pinnedRef.current = next
    setPinned(next)
    setOverflowing(hasOverflow(metricsOf(scroller)))
  }, [])

  // 监听用户滚动：上滚即解除跟随，回到底部立即恢复。
  useEffect(() => {
    const anchor = anchorRef.current
    const scroller = anchor ? findScrollParent(anchor) : null
    if (!scroller) return
    previousTop.current = scroller.scrollTop
    const pause = () => {
      pinnedRef.current = false
      setPinned(false)
    }
    const wheel = (event: WheelEvent) => { if (event.deltaY < 0) pause() }
    let touchY = 0
    const touchStart = (event: TouchEvent) => { touchY = event.touches[0]?.clientY ?? 0 }
    const touchMove = (event: TouchEvent) => {
      const next = event.touches[0]?.clientY ?? touchY
      if (next > touchY) pause()
      touchY = next
    }
    scroller.addEventListener("scroll", measure, { passive: true })
    scroller.addEventListener("wheel", wheel, { passive: true })
    scroller.addEventListener("touchstart", touchStart, { passive: true })
    scroller.addEventListener("touchmove", touchMove, { passive: true })
    // 尺寸变化不是用户操作，不应修改是否跟随。
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => {
      if (pinnedRef.current) {
        scroller.scrollTop = bottomScrollTop(metricsOf(scroller))
        previousTop.current = scroller.scrollTop
      }
      setOverflowing(hasOverflow(metricsOf(scroller)))
    })
    observer?.observe(scroller)
    // 表单和图片可能在时间线子组件内部改变高度，不一定触发 deps 更新。
    if (anchor?.parentElement) observer?.observe(anchor.parentElement)
    return () => {
      scroller.removeEventListener("scroll", measure)
      scroller.removeEventListener("wheel", wheel)
      scroller.removeEventListener("touchstart", touchStart)
      scroller.removeEventListener("touchmove", touchMove)
      observer?.disconnect()
    }
  }, [measure])

  // 内容更新：仅在贴底时跟随。
  useLayoutEffect(() => {
    const anchor = anchorRef.current
    const scroller = anchor ? findScrollParent(anchor) : null
    if (!scroller) return
    if (!pinnedRef.current) {
      setOverflowing(hasOverflow(metricsOf(scroller)))
      return
    }
    scroller.scrollTop = bottomScrollTop(metricsOf(scroller))
    previousTop.current = scroller.scrollTop
    setOverflowing(hasOverflow(metricsOf(scroller)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  const scrollToBottom = useCallback(() => {
    const anchor = anchorRef.current
    const scroller = anchor ? findScrollParent(anchor) : null
    if (!scroller) return
    scroller.scrollTop = bottomScrollTop(metricsOf(scroller))
    previousTop.current = scroller.scrollTop
    pinnedRef.current = true
    setPinned(true)
  }, [])

  return { anchorRef, pinned, overflowing, scrollToBottom, measure }
}
