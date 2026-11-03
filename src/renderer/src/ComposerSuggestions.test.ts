import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { DesktopAPI } from '../../shared/protocol'
import { ComposerSuggestions, useComposerSuggestions } from './ComposerSuggestions'

describe('composer suggestions', () => {
  let container: HTMLDivElement
  let root: Root
  let suggestions: ReturnType<typeof useComposerSuggestions>
  let edit: (value: string, caret?: number) => void
  let switchSession: (value: string) => void
  const listFiles = vi.fn<DesktopAPI['listFiles']>()
  const onCommand = vi.fn()
  const api = { listFiles } as unknown as DesktopAPI

  function Harness() {
    const [text, setText] = useState('')
    const [session, setSession] = useState('first')
    const textarea = useRef<HTMLTextAreaElement>(null)
    const form = useRef<HTMLFormElement>(null)
    suggestions = useComposerSuggestions({ text, sessionKey: session, workspace: '/work', hasSession: session !== 'new', disabled: false, api, textarea,
      onChange: setText, onCommand: command => { onCommand(command); setText('') } })
    edit = (value, caret = value.length) => { setText(value); suggestions.update(value, caret) }
    switchSession = setSession
    return createElement('form', { ref: form }, createElement('textarea', { ref: textarea, value: text, onChange: () => {}, onKeyDown: suggestions.onKeyDown, onBlur: suggestions.close }), createElement(ComposerSuggestions, { suggestions, anchor: form }))
  }

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0))
    HTMLElement.prototype.scrollIntoView = vi.fn()
    listFiles.mockReset().mockResolvedValue({ files: [], truncated: false })
    onCommand.mockReset()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root.render(createElement(Harness)))
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  const key = async (key: string, options: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options })
    await act(async () => container.querySelector('textarea')!.dispatchEvent(event))
    return event
  }

  it('navigates commands, selects with Enter, and clears the input', async () => {
    await act(async () => edit('/'))
    await key('ArrowDown')
    expect(suggestions.items[suggestions.selectedIndex].label).toBe('/settings')
    expect((await key('Enter')).defaultPrevented).toBe(true)
    expect(onCommand).toHaveBeenCalledWith(expect.objectContaining({ name: 'settings' }))
    expect(container.querySelector('textarea')!.value).toBe('')
    expect(suggestions.open).toBe(false)
  })

  it('does not interpret IME composition keys as selection or navigation', async () => {
    await act(async () => edit('/'))
    expect((await key('Enter', { isComposing: true })).defaultPrevented).toBe(false)
    expect((await key('ArrowDown', { keyCode: 229 })).defaultPrevented).toBe(false)
    expect(suggestions.selectedIndex).toBe(0)
    expect(onCommand).not.toHaveBeenCalled()
    expect(suggestions.open).toBe(true)
  })

  it('still handles a manually entered full session command when its suggestion is hidden', async () => {
    await act(async () => switchSession('new'))
    await act(async () => edit('/delete'))
    expect(suggestions.items).toEqual([])
    expect((await key('Enter')).defaultPrevented).toBe(true)
    expect(onCommand).toHaveBeenCalledWith(expect.objectContaining({ name: 'delete' }))
    expect(suggestions.open).toBe(false)
  })

  it('consumes Enter while files are loading and ignores older responses', async () => {
    let first!: (value: { files: string[]; truncated: boolean }) => void
    listFiles.mockReturnValueOnce(new Promise(resolve => { first = resolve }))
      .mockResolvedValueOnce({ files: ['src/new.ts'], truncated: false })
    await act(async () => edit('@old'))
    expect((await key('Enter')).defaultPrevented).toBe(true)
    await act(async () => vi.advanceTimersByTimeAsync(120))
    await act(async () => edit('@new'))
    await act(async () => vi.advanceTimersByTimeAsync(120))
    expect(suggestions.items.map(item => item.path)).toEqual(['src/new.ts'])
    await act(async () => first({ files: ['old.ts'], truncated: false }))
    expect(suggestions.items.map(item => item.path)).toEqual(['src/new.ts'])
    expect(listFiles).toHaveBeenCalledTimes(2)
  })

  it('debounces file lookups and inserts a normalized mention using Tab', async () => {
    listFiles.mockResolvedValue({ files: ['src/文件.ts'], truncated: false })
    await act(async () => edit('@文'))
    await act(async () => vi.advanceTimersByTimeAsync(60))
    await act(async () => edit('@文件'))
    await act(async () => vi.advanceTimersByTimeAsync(119))
    expect(listFiles).not.toHaveBeenCalled()
    await act(async () => vi.advanceTimersByTimeAsync(1))
    await key('Tab')
    await act(async () => vi.advanceTimersByTimeAsync(1))
    expect(container.querySelector('textarea')!.value).toBe('@src/文件.ts ')
    expect(container.querySelector('textarea')!.selectionStart).toBe('@src/文件.ts '.length)
    expect(suggestions.open).toBe(false)
  })

  it('closes on Escape, an outside click and session changes', async () => {
    await act(async () => edit('/'))
    await key('Escape')
    await act(async () => suggestions.update('/', 1))
    expect(suggestions.open).toBe(false)
    await act(async () => edit('/s'))
    await act(async () => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })))
    expect(suggestions.open).toBe(false)
    await act(async () => edit('/m'))
    await act(async () => switchSession('second'))
    expect(suggestions.open).toBe(false)
  })

  it('highlights the full path match without splitting Unicode characters', async () => {
    listFiles.mockResolvedValue({ files: ['docs/📄文.md'], truncated: false })
    await act(async () => edit('@d📄文'))
    await act(async () => vi.advanceTimersByTimeAsync(120))
    expect([...document.querySelectorAll('mark')].map(element => element.textContent)).toEqual(['📄', '文', 'd'])
  })

  it('does not carry a failed file lookup into command suggestions', async () => {
    listFiles.mockRejectedValue(new Error('Workspace missing'))
    await act(async () => edit('@missing'))
    await act(async () => vi.advanceTimersByTimeAsync(120))
    expect(suggestions.status).toBe('Unable to list workspace files.')
    await act(async () => edit('/missing'))
    expect(suggestions.status).toBe('No matches')
  })
})
