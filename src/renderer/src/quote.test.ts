import { describe, expect, it } from 'vitest'
import { createTextQuote, positionQuote } from './quote'

describe('selected answer quotes', () => {
  const answer = { element: {}, messageId: 'answer-1' }

  it('preserves the exact selected text, including code indentation and line breaks', () => {
    const text = '  const value = 1\n  return value\n'
    expect(createTextQuote(text, answer, answer)).toEqual({ text, messageId: 'answer-1' })
  })

  it('rejects empty selections and endpoints outside an allowed answer', () => {
    expect(createTextQuote(' \n\t', answer, answer)).toBeNull()
    expect(createTextQuote('A tool result', null, answer)).toBeNull()
    expect(createTextQuote('A tool result', answer, null)).toBeNull()
  })

  it('rejects selections spanning answers, even if duplicate DOM sources share an id', () => {
    expect(createTextQuote('Two answers', answer, { element: {}, messageId: 'answer-2' })).toBeNull()
    expect(createTextQuote('Duplicate id', answer, { element: {}, messageId: 'answer-1' })).toBeNull()
    expect(createTextQuote('Missing id', { element: answer.element, messageId: '' }, answer)).toBeNull()
  })
})

describe('quote popup placement', () => {
  const popup = { width: 68, height: 30 }
  const viewport = { width: 760, height: 560 }

  it('places the action beside the last visible selected line', () => {
    expect(positionQuote({ left: 100, right: 250, top: 200, bottom: 220 }, popup, viewport)).toEqual({ left: 182, top: 226 })
  })

  it('moves above a selection near the bottom and stays inside the right edge', () => {
    expect(positionQuote({ left: 730, right: 790, top: 530, bottom: 550 }, popup, viewport)).toEqual({ left: 684, top: 494 })
  })

  it('keeps the action visible for a selection at the top-left edge', () => {
    expect(positionQuote({ left: -20, right: 20, top: -10, bottom: 10 }, popup, viewport)).toEqual({ left: 8, top: 16 })
  })
})
