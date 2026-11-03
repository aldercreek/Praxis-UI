import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopAPI, DesktopInfo, PraxisEvent, SessionSnapshot, SessionSummary } from '../../shared/protocol'
import { usePraxis } from './usePraxis'

const session = (patch: Partial<SessionSummary> = {}): SessionSummary => ({ id: 'chat', title: 'Background task', workspace: '/work', model: 'test', status: 'running', updated_at: '', latest_turn: { id: 'turn', status: 'running' }, ...patch })

describe('notification event integration', () => {
  let root: Root
  let container: HTMLDivElement
  let praxis: ReturnType<typeof usePraxis>
  let emit: (event: PraxisEvent) => void
  let openFromNotification: (sessionId: string) => void
  let listed: SessionSummary[]
  let open: () => Promise<SessionSnapshot>
  const notify = vi.fn()
  const snapshot = (sequence = 10): SessionSnapshot => ({ session: listed[0], sequence, messages: [], approvals: [] })
  const emitEvent = (event: string, sequence: number, patch: Partial<PraxisEvent> = {}) => emit({ event, sequence, session_id: 'chat', turn_id: 'turn', data: {}, ...patch })

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    listed = [session()]
    open = async () => snapshot()
    notify.mockReset()
    const info: DesktopInfo = { connection: { state: 'connected' }, platform: 'win32', version: 'test', settings: { workspace: '/work', praxisPath: '/engine', pythonPath: '', model: 'test', baseUrl: '', apiKeyConfigured: true, bypassApprovals: true, notifications: true } }
    window.praxis = {
      notify, acknowledge: () => {}, onEvent: (listener: (event: PraxisEvent) => void) => { emit = listener; return () => {} },
      onConnection: () => () => {}, onOpenSession: (listener: (sessionId: string) => void) => { openFromNotification = listener; return () => {} },
      getInfo: async () => info,
      request: async (method: string) => {
        if (method === 'initialize') return { configured: true, model: 'test' }
        if (method === 'session.list') return { sessions: listed }
        if (method === 'session.open') return open()
        throw new Error(method)
      }
    } as unknown as DesktopAPI
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    function Harness() { praxis = usePraxis(); return null }
    await act(async () => root.render(createElement(Harness)))
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('establishes the list baseline and deduplicates completion events against polling', async () => {
    expect(praxis.listState).toBe('ready')
    expect(notify).not.toHaveBeenCalled()
    await act(async () => praxis.openSession('chat'))
    await act(async () => emitEvent('TurnCompleted', 11))
    listed = [session({ status: 'idle', latest_turn: { id: 'turn', status: 'completed' } })]
    await act(async () => praxis.refresh(true))
    expect(notify).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ key: 'chat:turn:completed' }))
  })

  it('suppresses buffered events, old snapshot sequences and polling while a snapshot is pending', async () => {
    let resolve!: (value: SessionSnapshot) => void
    open = () => new Promise(value => { resolve = value })
    let opening!: Promise<void>
    await act(async () => { opening = praxis.openSession('chat') })
    await act(async () => emitEvent('TurnCompleted', 8))
    listed = [session({ status: 'idle', latest_turn: { id: 'turn', status: 'completed' } })]
    await act(async () => praxis.refresh(true))
    expect(notify).not.toHaveBeenCalled()
    await act(async () => { resolve(snapshot(10)); await opening })
    await act(async () => emitEvent('ApprovalPending', 9, { data: { approval_id: 'old', tool_name: 'run_command' } }))
    expect(notify).not.toHaveBeenCalled()
    await act(async () => emitEvent('TurnCompleted', 11, { turn_id: 'next-turn' }))
    expect(notify).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ key: 'chat:next-turn:completed' }))
  })

  it('suppresses a terminal polling result during open even before its buffered event arrives', async () => {
    let resolve!: (value: SessionSnapshot) => void
    open = () => new Promise(value => { resolve = value })
    let opening!: Promise<void>
    await act(async () => { opening = praxis.openSession('chat') })
    listed = [session({ status: 'failed', latest_turn: { id: 'turn', status: 'failed' } })]
    await act(async () => praxis.refresh(true))
    await act(async () => { resolve(snapshot()); await opening })
    await act(async () => emitEvent('TurnFailed', 11))
    expect(notify).not.toHaveBeenCalled()
  })

  it('does not notify historical view events or child events and opens clicked sessions', async () => {
    open = async () => ({ ...snapshot(), view_events: [{ event: 'TurnFailed', sequence: 8, session_id: 'chat', turn_id: 'turn', data: {} }] })
    await act(async () => openFromNotification('chat'))
    expect(praxis.activeId).toBe('chat')
    expect(praxis.active?.loaded).toBe(true)
    await act(async () => emitEvent('TurnCompleted', 11, { agent_id: 'child' }))
    await act(async () => emitEvent('TurnCancelled', 12))
    expect(notify).not.toHaveBeenCalled()
    await act(async () => emitEvent('ApprovalPending', 13, { data: { approval_id: 'new', tool_name: 'run_command', arguments: { command: 'secret' } } }))
    expect(notify).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ key: 'new', body: 'Approval needed: run_command' }))
  })

  it('keeps snapshot history quiet when an older list response arrives afterwards', async () => {
    const completed = session({ status: 'idle', latest_turn: { id: 'turn', status: 'completed' } })
    open = async () => ({ ...snapshot(), session: completed, approvals: [{ approval_id: 'historical', tool_name: 'run_command', arguments: {} }] })
    await act(async () => praxis.openSession('chat'))
    await act(async () => praxis.refresh(true))
    listed = [completed]
    await act(async () => praxis.refresh(true))
    await act(async () => emitEvent('ApprovalPending', 11, { data: { approval_id: 'historical', tool_name: 'run_command' } }))
    expect(notify).not.toHaveBeenCalled()
  })
})
