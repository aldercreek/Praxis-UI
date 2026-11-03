export function constrainPreviewLinks() {
  const preventExternal = (event: MouseEvent) => {
    const link = event.target instanceof Element ? event.target.closest('a[href], area[href]') : null
    if (!link) return
    try {
      const current = new URL(location.href)
      const base = document.querySelector('base[href]')?.getAttribute('href')
      const target = new URL(link.getAttribute('href')!, base ? new URL(base, current) : current)
      if (target.protocol !== 'praxis-preview:' || target.hostname !== current.hostname) event.preventDefault()
    } catch { event.preventDefault() }
  }
  document.addEventListener('click', preventExternal, true)
  document.addEventListener('auxclick', preventExternal, true)
  return () => {
    document.removeEventListener('click', preventExternal, true)
    document.removeEventListener('auxclick', preventExternal, true)
  }
}
