import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

GlobalWorkerOptions.workerSrc = workerUrl

export default function PdfPreview({ dataUrl }: { dataUrl: string }) {
  const host = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [document, setDocument] = useState<PDFDocumentProxy>()
  const [pageNumber, setPageNumber] = useState(1)
  const [width, setWidth] = useState(400)
  const [error, setError] = useState('')
  const [rendering, setRendering] = useState(true)

  useEffect(() => {
    let active = true
    setDocument(undefined)
    setPageNumber(1)
    setError('')
    const data = Uint8Array.from(atob(dataUrl.slice(dataUrl.indexOf(',') + 1)), character => character.charCodeAt(0))
    const task = getDocument({ data, useSystemFonts: true })
    // Password-protected files need an external reader; do not leave the preview pending.
    task.onPassword = () => { if (active) setError('This PDF requires a password. Open it in the default app.'); void task.destroy() }
    void task.promise.then(value => { if (active) setDocument(value) }).catch(reason => {
      if (active) setError(previous => previous || `Unable to preview this PDF: ${String(reason.message || reason)}`)
    })
    return () => { active = false; void task.destroy() }
  }, [dataUrl])

  useEffect(() => {
    const element = host.current
    if (!element) return
    const resize = () => setWidth(Math.max(80, element.clientWidth - 32))
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!document || !canvas.current) return
    let active = true
    let render: ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']> | undefined
    setError('')
    setRendering(true)
    void document.getPage(pageNumber).then(page => {
      if (!active || !canvas.current) return
      const scale = width / page.getViewport({ scale: 1 }).width
      const viewport = page.getViewport({ scale })
      const ratio = Math.min(window.devicePixelRatio || 1, 2)
      canvas.current.width = Math.ceil(viewport.width * ratio)
      canvas.current.height = Math.ceil(viewport.height * ratio)
      canvas.current.style.width = `${viewport.width}px`
      canvas.current.style.height = `${viewport.height}px`
      render = page.render({ canvas: canvas.current, viewport, transform: [ratio, 0, 0, ratio, 0, 0] })
      return render.promise
    }).then(() => { if (active) setRendering(false) }).catch(reason => {
      if (active && reason?.name !== 'RenderingCancelledException') { setError(`Unable to preview this page: ${String(reason.message || reason)}`); setRendering(false) }
    })
    return () => { active = false; render?.cancel() }
  }, [document, pageNumber, width])

  return <div className="pdf-viewer" ref={host}>
    <div className="pdf-toolbar"><button type="button" className="icon-button" aria-label="Previous page" disabled={!document || pageNumber <= 1} onClick={() => setPageNumber(value => value - 1)}><ChevronLeft size={16} /></button>
      <span>{document ? `${pageNumber} / ${document.numPages}` : 'PDF'}</span>
      <button type="button" className="icon-button" aria-label="Next page" disabled={!document || pageNumber >= document.numPages} onClick={() => setPageNumber(value => value + 1)}><ChevronRight size={16} /></button></div>
    <div className="pdf-page" aria-busy={!error && (!document || rendering)}>
      {error ? <p className="preview-notice" role="status">{error}</p> : !document && <p className="preview-notice">Loading PDF…</p>}
      <canvas ref={canvas} hidden={Boolean(error)} aria-label={`PDF page ${pageNumber}`} role="img" />
    </div>
  </div>
}
