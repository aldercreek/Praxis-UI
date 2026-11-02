export function trackScrollActivity(target: Pick<Document, 'addEventListener' | 'removeEventListener'>, idle = 900) {
  const timers = new Map<Element, ReturnType<typeof setTimeout>>()
  const onScroll = (event: Event) => {
    const element = event.target
    if (!element || typeof (element as Element).setAttribute !== 'function') return
    const node = element as Element
    if (!node.hasAttribute('data-scrolling')) node.setAttribute('data-scrolling', '')
    clearTimeout(timers.get(node))
    timers.set(node, setTimeout(() => { node.removeAttribute('data-scrolling'); timers.delete(node) }, idle))
  }
  target.addEventListener('scroll', onScroll, { capture: true, passive: true })
  return () => {
    target.removeEventListener('scroll', onScroll, { capture: true })
    for (const [node, timer] of timers) { clearTimeout(timer); node.removeAttribute('data-scrolling') }
    timers.clear()
  }
}
