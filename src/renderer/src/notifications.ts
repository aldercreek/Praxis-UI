import type { DesktopNotification, PraxisEvent, SessionSummary } from '../../shared/protocol'
import { isChildAgent } from './state'

const failureBody = (error: unknown) => {
  const detail = typeof error === 'string' ? error.split(/[\r\n]/, 1)[0].trim().slice(0, 120) : ''
  return detail ? `Task failed: ${detail}` : 'Task failed'
}

export function notificationFromEvent(event: PraxisEvent, summary?: SessionSummary): DesktopNotification | undefined {
  const sessionId = event.session_id
  if (!sessionId || isChildAgent(event.agent_id)) return
  const title = summary?.title || 'New chat'
  if (event.event === 'ApprovalPending') {
    if (typeof event.data.approval_id !== 'string' || !event.data.approval_id || typeof event.data.tool_name !== 'string') return
    return { key: event.data.approval_id, sessionId, kind: 'approval', title, body: `Approval needed: ${event.data.tool_name}` }
  }
  if (!event.turn_id) return
  const kind = event.event === 'TurnCompleted' ? 'completed' : event.event === 'TurnFailed' ? 'failed' : undefined
  if (!kind) return
  const error = event.data.message ?? event.data.error ?? (summary?.latest_turn?.id === event.turn_id ? summary.latest_turn.error : undefined)
  return { key: `${sessionId}:${event.turn_id}:${kind}`, sessionId, kind, title, body: kind === 'completed' ? 'Task completed' : failureBody(error) }
}

export function notificationsFromList(previous: SessionSummary[], next: SessionSummary[]): DesktopNotification[] {
  const before = new Map(previous.map(session => [session.id, session]))
  return next.flatMap(session => {
    const old = before.get(session.id)
    const turn = session.latest_turn
    if (!old || !turn) return []
    const completed = old.status === 'running' && session.status === 'idle' && turn.status === 'completed'
    const failed = turn.status === 'failed' && (old.latest_turn?.id !== turn.id || old.latest_turn.status !== 'failed')
    if (!completed && !failed) return []
    const notification = notificationFromEvent({ event: failed ? 'TurnFailed' : 'TurnCompleted', session_id: session.id, turn_id: turn.id, data: { error: turn.error } }, session)
    return notification ? [notification] : []
  })
}

export function rememberNotification(keys: Set<string>, key: string): boolean {
  if (keys.has(key)) return false
  keys.add(key)
  if (keys.size > 500) keys.delete(keys.values().next().value!)
  return true
}
