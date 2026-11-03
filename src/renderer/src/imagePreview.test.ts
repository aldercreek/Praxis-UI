import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createImagePreviewCache } from './imagePreview'
import { clampImageZoom, fitImageScale, imagePan } from './imageView'
import { ImageLightbox } from './ImageLightbox'
import { ImagePreviewTooltip } from './ImagePreviewTooltip'
import type { FilePreview } from '../../shared/protocol'

const preview: FilePreview = { kind: 'image', name: 'image.png', path: '/work/image.png', dataUrl: 'data:image/png;base64,abc', size: 3, canOpen: true }
let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('image bounds and cache', () => {
  it('clamps manual zoom and pan while fitting large and small images', () => {
    expect([.1, .5, 1, 4, 10].map(clampImageZoom)).toEqual([.5, .5, 1, 4, 4])
    expect(fitImageScale(2000, 1000, 1000, 800)).toBe(.45)
    expect(fitImageScale(20, 20, 1000, 800)).toBe(1)
    expect(imagePan(999, -999, 2000, 1000, 1000, 800)).toEqual({ x: 500, y: -100 })
    expect(imagePan(5, 5, 20, 20, 1000, 800)).toEqual({ x: 0, y: 0 })
  })
  it('deduplicates requests, keeps at most 30 images and separates workspaces', async () => {
    const cache = createImagePreviewCache()
    const load = vi.fn(async () => preview)
    await Promise.all([cache('/one', '0', load), cache('/one', '0', load)])
    expect(load).toHaveBeenCalledOnce()
    for (let index = 1; index <= 30; index += 1) await cache('/one', String(index), load)
    await cache('/one', '1', load)
    expect(load).toHaveBeenCalledTimes(31)
    await cache('/one', '0', load)
    await cache('/two', '0', load)
    expect(load).toHaveBeenCalledTimes(33)
    const broken = vi.fn().mockRejectedValueOnce(new Error('Missing')).mockResolvedValue(preview)
    await expect(cache('/one', 'broken', broken)).rejects.toThrow('Missing')
    await expect(cache('/one', 'broken', broken)).resolves.toBe(preview.dataUrl)
  })
})

describe('image interactions', () => {
  it('restores thumbnail focus after a modal cancel and constrains toolbar zoom', async () => {
    const trigger = document.createElement('button')
    container.append(trigger)
    trigger.focus()
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.setAttribute('open', '') } })
    Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.removeAttribute('open') } })
    const close = vi.fn()
    const host = document.createElement('div')
    container.append(host)
    const modal = createRoot(host)
    try {
      await act(async () => modal.render(createElement(ImageLightbox, { src: preview.dataUrl!, name: preview.name, onClose: close, onOpenPanel: vi.fn() })))
      for (let index = 0; index < 25; index += 1) await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!.click())
      expect(document.querySelector('dialog img')!.getAttribute('data-zoom')).toBe('4')
      await act(async () => document.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true })))
      expect(close).toHaveBeenCalledOnce()
      await act(async () => modal.unmount())
      expect(document.activeElement).toBe(trigger)
    } finally { host.remove() }
  })
  it('waits 400ms before loading and cancels a short hover; focus opens the same tooltip', async () => {
    vi.useFakeTimers()
    const load = vi.fn(async () => preview)
    vi.stubGlobal('praxis', { previewFile: load })
    await act(async () => root.render(createElement(ImagePreviewTooltip, { workspace: '/hover', path: 'one.png', label: '/hover/one.png', children: createElement('a', { href: '#' }, 'Image') })))
    const link = container.querySelector('a')!
    await act(async () => link.dispatchEvent(new MouseEvent('pointerover', { bubbles: true })))
    await act(async () => vi.advanceTimersByTime(399))
    expect(load).not.toHaveBeenCalled()
    await act(async () => link.dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: document.body })))
    await act(async () => vi.advanceTimersByTime(400))
    expect(load).not.toHaveBeenCalled()
    await act(async () => link.focus())
    await act(async () => vi.advanceTimersByTime(400))
    expect(load).toHaveBeenCalledOnce()
    expect(document.querySelector('[role="tooltip"] img')).not.toBeNull()
    expect(document.querySelector('[role="tooltip"]')!.textContent).toBe('/hover/one.png')
    await act(async () => link.blur())
    expect(document.querySelector('[role="tooltip"]')).toBeNull()
  })
})
