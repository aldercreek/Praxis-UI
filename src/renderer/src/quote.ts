export interface TextQuote { text: string; messageId: string }

export interface QuoteSource { element: object; messageId: string }

export function createTextQuote(text: string, start: QuoteSource | null, end: QuoteSource | null): TextQuote | null {
  if (!text.trim() || !start?.messageId || !end || start.element !== end.element || start.messageId !== end.messageId) return null
  return { text, messageId: start.messageId }
}

export interface QuoteAnchor { left: number; right: number; top: number; bottom: number }

export function positionQuote(anchor: QuoteAnchor, popup: { width: number; height: number }, viewport: { width: number; height: number }) {
  const margin = 8
  const gap = 6
  const left = Math.min(Math.max(margin, anchor.right - popup.width), Math.max(margin, viewport.width - popup.width - margin))
  const below = anchor.bottom + gap
  const preferredTop = below + popup.height <= viewport.height - margin ? below : anchor.top - popup.height - gap
  const top = Math.min(Math.max(margin, preferredTop), Math.max(margin, viewport.height - popup.height - margin))
  return { left, top }
}
