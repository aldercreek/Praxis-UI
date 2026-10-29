import { useLayoutEffect, useState, type RefObject } from 'react'

// Composer controls can move without changing their own size, for example
// when an agent panel opens beside an already width-limited conversation.
export function useComposerPopover(open: boolean, anchor: RefObject<HTMLElement | null>, align: 'start' | 'end', maximumHeight: number) {
  const [position, setPosition] = useState({ left: 16, bottom: 16, width: 420, maxHeight: maximumHeight })
  useLayoutEffect(() => {
    const node = anchor.current
    if (!open || !node) return
    const measure = () => {
      const rect = node.getBoundingClientRect()
      const bar = node.closest('.execution-bar')?.getBoundingClientRect() || rect
      const left = Math.max(16, bar.left)
      const right = Math.min(window.innerWidth - 16, bar.right)
      const width = Math.max(0, Math.min(420, right - left))
      setPosition({
        left: Math.max(left, Math.min(align === 'start' ? rect.left : rect.right - width, right - width)),
        bottom: window.innerHeight - rect.top + 8,
        width,
        maxHeight: Math.min(maximumHeight, Math.max(0, rect.top - 24))
      })
    }
    measure()
    const observer = new ResizeObserver(measure)
    for (let ancestor: HTMLElement | null = node; ancestor; ancestor = ancestor.parentElement) observer.observe(ancestor)
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true) }
  }, [open, anchor, align, maximumHeight])
  return position
}
