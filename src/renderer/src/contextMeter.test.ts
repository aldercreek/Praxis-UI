import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { contextColor, formatTokens } from './contextUsage'
import { ContextMeter } from './ContextMeter'

describe('context meter', () => {
  it.each([[54120, '54.1k'], [128000, '128k'], [52800, '52.8k'], [0, '0k'], [999, '1k']])('formats %s tokens as %s', (tokens, expected) => {
    expect(formatTokens(Number(tokens))).toBe(expected)
  })

  it.each([['normal', 'muted'], ['soft', 'warning'], ['hard', 'error'], ['emergency', 'error'], ['unknown', 'muted']])('maps %s to the shared %s color', (pressure, color) => {
    expect(contextColor(pressure)).toBe(`var(--${color})`)
  })

  it('omits missing data and exposes an accessible label when available', () => {
    expect(renderToStaticMarkup(createElement(ContextMeter, { activity: '' }))).toBe('')
    const context = { percent: 42.2, estimated: 54120, limit: 128000, pressure: 'normal' }
    expect(renderToStaticMarkup(createElement(ContextMeter, { context, activity: '' }))).toContain('aria-label="Context 42% used"')
    const compacting = renderToStaticMarkup(createElement(ContextMeter, { context, activity: 'Compacting context' }))
    expect(compacting).toContain('aria-label="Compacting context…"')
    expect(compacting).toContain('is-compacting')
  })
})
