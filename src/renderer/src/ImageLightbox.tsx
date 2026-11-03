import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowUpRight, Minus, Plus, RotateCw, X } from './icons'
import { clampImageZoom, fitImageScale, imagePan } from './imageView'
import './imagePreview.css'

export function ImageLightbox({ src, name, onClose, onOpenPanel }: { src: string; name: string; onClose: () => void; onOpenPanel: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; y: number; startX: number; startY: number } | undefined>(undefined)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight })
  const [view, setView] = useState<{ zoom?: number; x: number; y: number }>({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const fit = fitImageScale(size.width, size.height, viewport.width, viewport.height)
  const zoom = view.zoom ?? fit
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom
  const changeZoom = (value: number) => setView({ zoom: clampImageZoom(value), x: 0, y: 0 })
  useEffect(() => {
    const previous = document.activeElement
    const node = dialog.current!
    node.showModal()
    const resize = () => { setViewport({ width: window.innerWidth, height: window.innerHeight }); setView(value => ({ ...value, x: 0, y: 0 })) }
    window.addEventListener('resize', resize)
    return () => { window.removeEventListener('resize', resize); node.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }) }
  }, [])
  useEffect(() => {
    const node = stage.current!
    const wheel = (event: WheelEvent) => { event.preventDefault(); changeZoom(zoomRef.current + (event.deltaY < 0 ? .25 : -.25)) }
    node.addEventListener('wheel', wheel, { passive: false })
    return () => node.removeEventListener('wheel', wheel)
  }, [])
  return createPortal(<dialog ref={dialog} className="praxis-dialog image-lightbox" aria-label={`Image: ${name}`} onCancel={event => { event.preventDefault(); event.stopPropagation(); onClose() }}
    onKeyDown={event => { if (event.key === 'Escape') event.stopPropagation() }} onClick={event => { if (event.target === event.currentTarget || event.target === stage.current) onClose() }}>
    <div className="image-lightbox-toolbar"><span>{name}</span>
      <button type="button" className="icon-button" aria-label="Zoom out" title="Zoom out" disabled={zoom <= .5} onClick={() => changeZoom(zoom - .25)}><Minus size={16} /></button>
      <button type="button" className="icon-button" aria-label="Zoom in" title="Zoom in" disabled={zoom >= 4} onClick={() => changeZoom(zoom + .25)}><Plus size={16} /></button>
      <button type="button" className="icon-button" aria-label="Fit image" title="Fit" onClick={() => setView({ x: 0, y: 0 })}><RotateCw size={16} /></button>
      <button type="button" className="icon-button" aria-label="Open in panel" title="Open in panel" onClick={() => { onClose(); onOpenPanel() }}><ArrowUpRight size={16} /></button>
      <button type="button" className="icon-button" aria-label="Close image" title="Close · Esc" autoFocus onClick={onClose}><X size={16} /></button>
    </div>
    <div ref={stage} className={`image-lightbox-stage ${dragging ? 'is-dragging' : ''}`}>
      <img src={src} alt={name} draggable={false} data-zoom={zoom} style={{ width: size.width * zoom || undefined, height: size.height * zoom || undefined, transform: `translate(-50%, -50%) translate(${view.x}px, ${view.y}px)`, cursor: zoom > fit ? dragging ? 'grabbing' : 'grab' : 'zoom-in' }}
        onLoad={event => setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
        onDoubleClick={() => setView({ zoom: view.zoom === undefined ? 1 : undefined, x: 0, y: 0 })}
        onPointerDown={event => { if (zoom <= fit || event.button !== 0) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); drag.current = { x: view.x, y: view.y, startX: event.clientX, startY: event.clientY }; setDragging(true) }}
        onPointerMove={event => { if (!drag.current) return; const bounds = stage.current!.getBoundingClientRect(); const pan = imagePan(drag.current.x + event.clientX - drag.current.startX, drag.current.y + event.clientY - drag.current.startY, size.width * zoom, size.height * zoom, bounds.width, bounds.height); setView(value => ({ ...value, ...pan })) }}
        onPointerUp={() => { drag.current = undefined; setDragging(false) }} onPointerCancel={() => { drag.current = undefined; setDragging(false) }} />
    </div>
  </dialog>, document.body)
}
