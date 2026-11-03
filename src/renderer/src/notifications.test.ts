import { describe, expect, it } from 'vitest'
import type { PraxisEvent, SessionSummary } from '../../shared/protocol'
import { notificationFromEvent, notificationsFromList, rememberNotification } from './notifications'

const summary = (patch: Partial<SessionSummary> = {}): SessionSummary => ({ id: 'chat', title: 'Review files', workspace: '/work', model: 'test', status: 'running', updated_at: '', latest_turn: { id: 'turn', status: 'running' }, ...patch })
const event = (name: string, patch: Partial<PraxisEvent> = {}): PraxisEvent => ({ event: name, session_id: 'chat', turn_id: 'turn', agent_id: 'main', data: {}, ...patch })

describe('desktop notification candidates', () => {
  it('produces completion, failure and private approval text', () => {
    expect(notificationFromEvent(event('TurnCompleted'), summary())).toEqual({ key: 'chat:turn:completed', sessionId: 'chat', kind: 'completed', title: 'Review files', body: 'Task completed' })
    expect(notificationFromEvent(event('TurnFailed', { data: { message: 'Connection lost\nPrivate stack trace' } }), summary())?.body).toBe('Task failed: Connection lost')
    expect(notificationFromEvent(event('ApprovalPending', { data: { approval_id: 'approval', tool_name: 'run_command', arguments: { command: 'secret command' } } }), summary())).toEqual({ key: 'approval', sessionId: 'chat', kind: 'approval', title: 'Review files', body: 'Approval needed: run_command' })
  })

  it('ignores cancelled, child and incomplete events', () => {
    expect(notificationFromEvent(event('TurnCancelled'), summary())).toBeUndefined()
    for (const name of ['TurnCompleted', 'TurnFailed', 'ApprovalPending']) expect(notificationFromEvent(event(name, { agent_id: 'child' }), summary())).toBeUndefined()
    expect(notificationFromEvent(event('TurnCompleted', { turn_id: undefined }), summary())).toBeUndefined()
    expect(notificationFromEvent(event('TurnCompleted', { session_id: undefined }), summary())).toBeUndefined()
    expect(notificationFromEvent(event('ApprovalPending'), summary())).toBeUndefined()
  })

  it('limits failure details to the first 120 characters', () => {
    expect(notificationFromEvent(event('TurnFailed', { data: { error: 'a'.repeat(200) + '\r\nstack' } }), summary())?.body).toBe('Task failed: ' + 'a'.repeat(120))
    expect(notificationFromEvent(event('TurnFailed'), summary())?.body).toBe('Task failed')
  })

  it('establishes the first list baseline and ignores newly discovered history', () => {
    const completed = summary({ status: 'idle', latest_turn: { id: 'turn', status: 'completed' } })
    expect(notificationsFromList([], [completed])).toEqual([])
    expect(notificationsFromList([summary({ id: 'other' })], [completed])).toEqual([])
    expect(notificationsFromList([completed], [completed])).toEqual([])
    expect(notificationsFromList([summary()], [summary({ status: 'cancelled', latest_turn: { id: 'turn', status: 'cancelled' } })])).toEqual([])
  })

  it('deduplicates event and polling results for the same turn', () => {
    const completed = summary({ status: 'idle', latest_turn: { id: 'turn', status: 'completed' } })
    const candidates = [notificationFromEvent(event('TurnCompleted'), summary())!, ...notificationsFromList([summary()], [completed])]
    const keys = new Set<string>()
    expect(candidates.filter(item => rememberNotification(keys, item.key))).toHaveLength(1)
    const failed = summary({ status: 'failed', latest_turn: { id: 'turn', status: 'failed', error: 'Failed once\nmore detail' } })
    expect(notificationsFromList([summary()], [failed])[0].body).toBe('Task failed: Failed once')
    expect(notificationsFromList([failed], [failed])).toEqual([])
  })

  it('keeps at most the most recent 500 notification keys', () => {
    const keys = new Set<string>()
    for (let i = 0; i < 501; i++) rememberNotification(keys, String(i))
    expect(keys.size).toBe(500)
    expect(keys.has('0')).toBe(false)
    expect(rememberNotification(keys, '500')).toBe(false)
  })
})
