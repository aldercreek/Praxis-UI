import { afterEach, expect, it, vi } from 'vitest'
import { constrainPreviewLinks } from './preview-navigation'

afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals() })
it('keeps external links from replacing the preview with a CSP error page', () => {
  vi.stubGlobal('location', { href: 'praxis-preview://workspace/docs/index.html' })
  const cleanup = constrainPreviewLinks()
  try {
    for (const href of ['https://example.com', 'file:///private.txt', 'data:text/html,test', 'praxis-preview://another/private.html']) {
      const link = document.createElement('a')
      link.href = href
      document.body.append(link)
      const event = new MouseEvent('click', { bubbles: true, cancelable: true })
      link.dispatchEvent(event)
      expect(event.defaultPrevented, href).toBe(true)
    }
    const link = document.createElement('a')
    link.href = '../next.html'
    document.body.append(link)
    const event = new MouseEvent('auxclick', { bubbles: true, cancelable: true })
    link.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    const base = document.createElement('base')
    base.href = 'https://example.com/'
    document.body.append(base)
    const redirected = new MouseEvent('click', { bubbles: true, cancelable: true })
    link.dispatchEvent(redirected)
    expect(redirected.defaultPrevented).toBe(true)
  } finally { cleanup() }
})
