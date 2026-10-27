import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export function FilePathTooltip({ path, children }: { path: string; children: ReactNode }) {
  const id = useId()
  const anchor = useRef<HTMLSpanElement>(null)
  const tooltip = useRef<HTMLSpanElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ left: 0, top: 0 })
  const close = () => { clearTimeout(timer.current); setOpen(false) }
  const show = () => { clearTimeout(timer.current); timer.current = setTimeout(() => setOpen(true), 400) }
  useEffect(() => () => clearTimeout(timer.current), [])
  useEffect(() => {
    if (!open) return
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    window.addEventListener('keydown', key)
    return () => { window.removeEventListener('scroll', close, true); window.removeEventListener('resize', close); window.removeEventListener('keydown', key) }
  }, [open])
  useLayoutEffect(() => {
    if (!open || !anchor.current || !tooltip.current) return
    const rect = anchor.current.getBoundingClientRect()
    const box = tooltip.current.getBoundingClientRect()
    setPosition({ left: Math.max(8, Math.min(rect.left + (rect.width - box.width) / 2, window.innerWidth - box.width - 8)), top: rect.top >= box.height + 16 ? rect.top - box.height - 8 : rect.bottom + 8 })
  }, [open, path])
  return <span ref={anchor} className="file-tooltip-anchor" aria-describedby={open ? id : undefined} onPointerEnter={show} onPointerLeave={close} onFocus={show} onBlur={close} onClick={close}>
    {children}
    {open && createPortal(<span ref={tooltip} id={id} role="tooltip" className="file-path-tooltip" style={position}>{path}</span>, document.body)}
  </span>
}
