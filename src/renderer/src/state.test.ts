import { describe, expect, it } from 'vitest'
import type { PraxisEvent, SessionSnapshot, SessionSummary } from '../../shared/protocol'
import { applyEvent, applySnapshot, emptyConversation, type Conversation } from './state'

const session: SessionSummary = { id: 'session-a', title: 'Task A', workspace: '/work', model: 'test', status: 'running', updated_at: '2026-10-20T00:00:00Z' }
const event = (name: string, sequence: number, data: Record<string, unknown> = {}, agentId = 'main'): PraxisEvent => ({ event: name, session_id: session.id, turn_id: 'turn-a', agent_id: agentId, sequence, data })

describe('conversation event reconciliation', () => {
  it('treats main as the root agent and consumes its optimistic user message', () => {
    const initial = { ...emptyConversation(), summary: session, messages: [{ id: 'local', role: 'user' as const, content: 'hello', status: 'sending' }] }
    const started = applyEvent(initial, event('TurnStarted', 1, { task: 'hello' }))
    expect(started.messages).toHaveLength(1)
    expect(started.messages[0].status).toBe('received')
    expect(started.activity).toBe('Thinking')
  })

  it('reconciles a running snapshot with only events after its sequence', () => {
    const snapshot: SessionSnapshot = { session, sequence: 4, approvals: [], messages: [{ id: 'assistant:turn-a:main:turn-a:1', role: 'assistant', content: 'hello', turn_id: 'turn-a', agent_id: 'main' }] }
    const restored = applySnapshot(snapshot, [event('AssistantTextDelta', 3, { request_number: 1, text: 'duplicate' }), event('AssistantTextDelta', 5, { request_number: 1, text: ' world' })])
    expect(restored.messages).toHaveLength(1)
    expect(restored.messages[0].content).toBe('hello world')
    expect(restored.sequence).toBe(5)
  })

  it('separates repeated model request numbers in different child turns', () => {
    let current = emptyConversation()
    current = applyEvent(current, event('AssistantTextDelta', 1, { request_number: 1, child_turn_id: 'child-turn-1', text: 'first' }, 'worker'))
    current = applyEvent(current, event('AssistantTextDelta', 2, { request_number: 1, child_turn_id: 'child-turn-2', text: 'second' }, 'worker'))
    expect(current.messages.map(message => message.content)).toEqual(['first', 'second'])
    expect(new Set(current.messages.map(message => message.id)).size).toBe(2)
  })

  it('uses model completion output if streaming deltas were unavailable without duplicating final text', () => {
    let current = emptyConversation()
    current = applyEvent(current, event('ModelRequestCompleted', 1, { request_number: 1, output_text: 'answer' }))
    current = applyEvent(current, event('AssistantTextCompleted', 2, { text: 'answer' }))
    expect(current.messages).toHaveLength(1)
    expect(current.messages[0].content).toBe('answer')
  })

  it('updates a tool already present in a running snapshot and respects success:false', () => {
    const snapshot: SessionSnapshot = { session, sequence: 5, approvals: [], messages: [{ id: 'tool:turn-a:main:call-1', role: 'tool', tool_name: 'shell', call_id: 'call-1', content: '', status: 'running' }] }
    const next = applyEvent(applySnapshot(snapshot), event('ToolFinished', 6, { call_id: 'call-1', tool_name: 'shell', result: { success: false, output: 'permission denied' } }))
    expect(next.messages).toHaveLength(1)
    expect(next.messages[0]).toMatchObject({ status: 'failed', error: true, content: 'permission denied' })
  })

  it('does not end the parent run when a child completes', () => {
    const initial = { ...emptyConversation(), summary: session, activity: 'working' }
    const next = applyEvent(initial, event('TurnCompleted', 1, {}, 'worker'))
    expect(next.summary?.status).toBe('running')
    expect(next.activity).toBe('working')
  })

  it('keeps a yielded command running through settlement and snapshot reload', () => {
    let current = applyEvent({ ...emptyConversation(), summary: session }, event('ToolFinished', 1, {
      call_id: 'command', tool_name: 'run_command', result: { success: true, output: 'server started', structured_output: { session_id: 'cmd-1', status: 'running' } }
    }))
    expect(current.messages[0]).toMatchObject({ status: 'running', tool_finished: true, structured_output: { session_id: 'cmd-1' } })
    current = applyEvent(current, event('TurnSettled', 2, { status: 'idle' }))
    expect(current.messages[0].status).toBe('running')
    expect(applySnapshot({ session: current.summary!, messages: current.messages, approvals: [], sequence: 2 }).messages[0].status).toBe('running')
  })

  it('uses a later wait result to finish only the matching command and preserves its original output', () => {
    let current = emptyConversation()
    for (const [index, agent] of ['main', 'worker'].entries()) {
      current = applyEvent(current, event('ToolFinished', index + 1, {
        call_id: 'command', tool_name: 'run_command', result: { success: true, output: 'starting', structured_output: { session_id: 'cmd-1', status: 'running' } }
      }, agent))
    }
    current = applyEvent(current, event('ToolFinished', 3, {
      call_id: 'wait', tool_name: 'wait_command', result: { success: true, output: 'test failed', structured_output: { session_id: 'cmd-1', status: 'exited', exit_code: 1 } }
    }))
    expect(current.messages.map(message => message.status)).toEqual(['failed', 'running', 'failed'])
    expect(current.messages[0].content).toBe('starting')
    expect(current.messages[0].structured_output?.exit_code).toBe(1)
  })

  it('restores command failure from structured exit status even when the tool call succeeded', () => {
    const messages = [{ id: 'command', role: 'tool' as const, tool_name: 'run_command', status: 'completed', content: 'exit 1', structured_output: { status: 'exited', exit_code: 1 } }]
    expect(applySnapshot({ session: { ...session, status: 'idle' }, messages, approvals: [], sequence: 1 }).messages[0].status).toBe('failed')
  })

  it('retains unconsumed supplement input after cancellation and removes pending approvals', () => {
    let current: Conversation = { ...emptyConversation(), summary: session, approvals: [{ approval_id: 'approval-1', tool_name: 'shell', arguments: {} }] }
    current = applyEvent(current, event('TurnCancelled', 1))
    current = applyEvent(current, event('InputsPaused', 2, { texts: ['also check tests'] }))
    expect(current.approvals).toEqual([])
    expect(current.pausedInputs).toEqual(['also check tests'])
    expect(current.summary?.status).toBe('stopping')
    current = applyEvent(current, event('TurnSettled', 3, { status: 'cancelled' }))
    expect(current.summary?.status).toBe('cancelled')
  })

  it('preserves a deliberate approval rejection when its unsuccessful tool result arrives', () => {
    let current = applyEvent(emptyConversation(), event('ToolCallPrepared', 1, { call_id: 'call-1', tool_name: 'shell', requires_approval: true }))
    current = applyEvent(current, event('ApprovalResolved', 2, { call_id: 'call-1', tool_name: 'shell', approved: false }))
    current = applyEvent(current, event('ToolFinished', 3, { call_id: 'call-1', tool_name: 'shell', result: { success: false, output: '用户拒绝执行' } }))
    expect(current.messages[0]).toMatchObject({ status: 'denied', error: false, content: '用户拒绝执行' })
  })

  it('keeps a completed root run busy until its cleanup settles', () => {
    let current: Conversation = { ...emptyConversation(), summary: session, activity: 'working' }
    current = applyEvent(current, event('TurnCompleted', 1))
    expect(current.summary?.status).toBe('running')
    expect(current.activity).toBe('Finishing task')
    current = applyEvent(current, event('TurnSettled', 2, { status: 'completed' }))
    expect(current.summary?.status).toBe('idle')
    expect(current.activity).toBe('')
  })

  it('stops unfinished tools for a cancelled root turn while retaining earlier and terminal rows', () => {
    const initial: Conversation = { ...emptyConversation(), summary: session, messages: [
      { id: 'running', role: 'tool', content: '', status: 'running', turn_id: 'turn-a', agent_id: 'main' },
      { id: 'pending', role: 'tool', content: '', status: 'pending', turn_id: 'turn-a', agent_id: 'worker' },
      { id: 'approval', role: 'tool', content: '', status: 'approval', turn_id: 'turn-a', agent_id: 'main' },
      { id: 'denied', role: 'tool', content: '', status: 'denied', turn_id: 'turn-a', agent_id: 'main' },
      { id: 'completed', role: 'tool', content: '', status: 'complete', turn_id: 'turn-a', agent_id: 'main' },
      { id: 'older', role: 'tool', content: '', status: 'complete', turn_id: 'previous-turn', agent_id: 'main' }
    ] }
    const next = applyEvent(initial, event('TurnCancelled', 1))
    expect(next.messages.filter(message => message.role === 'tool').map(message => message.status)).toEqual(['cancelled', 'cancelled', 'cancelled', 'denied', 'complete', 'complete'])
  })

  it('stops unfinished rows at settlement even when no cancellation event was emitted', () => {
    const initial: Conversation = { ...emptyConversation(), summary: session, messages: [
      { id: 'pending', role: 'tool', content: '', status: 'pending', turn_id: 'turn-a', agent_id: 'main' },
      { id: 'streaming', role: 'assistant', content: 'partial output', status: 'streaming', turn_id: 'turn-a', agent_id: 'worker' }
    ] }
    const next = applyEvent(initial, event('TurnSettled', 1, { status: 'failed' }))
    expect(next.summary?.status).toBe('failed')
    expect(next.messages.map(message => message.status)).toEqual(['cancelled', 'complete'])
  })

  it('finishes a child without altering root or other child work', () => {
    const initial: Conversation = { ...emptyConversation(), summary: session, activity: 'working', approvals: [{ approval_id: 'root-approval', tool_name: 'shell', arguments: {}, agent_id: 'main' }], messages: [
      { id: 'root-tool', role: 'tool', content: '', status: 'running', turn_id: 'turn-a', agent_id: 'main' },
      { id: 'child-tool', role: 'tool', content: '', status: 'running', turn_id: 'turn-a', agent_id: 'worker' },
      { id: 'other-child', role: 'tool', content: '', status: 'running', turn_id: 'turn-a', agent_id: 'other-worker' }
    ] }
    const next = applyEvent(initial, event('TurnCompleted', 1, {}, 'worker'))
    expect(next.summary?.status).toBe('running')
    expect(next.activity).toBe('working')
    expect(next.approvals).toEqual(initial.approvals)
    expect(next.messages.map(message => message.status)).toEqual(['running', 'cancelled', 'running'])
  })

  it('normalizes stale unfinished tool states when reopening an inactive snapshot', () => {
    const next = applySnapshot({ session: { ...session, status: 'cancelled' }, sequence: 5, approvals: [], messages: [{ id: 'tool', role: 'tool', content: '', status: 'running', turn_id: 'turn-a' }] })
    expect(next.messages[0].status).toBe('cancelled')
  })

  it('shows cancellation instead of denial when Stop interrupts an approval wait', () => {
    let current = applyEvent(emptyConversation(), event('ToolCallPrepared', 1, { call_id: 'call-1', tool_name: 'shell', requires_approval: true }))
    current = applyEvent(current, event('ApprovalResolved', 2, { call_id: 'call-1', tool_name: 'shell', approved: false }))
    current = applyEvent(current, event('TurnCancelled', 3))
    expect(current.messages[0].status).toBe('cancelled')
  })

  it('keeps a completed denial intact when the run later stops', () => {
    let current = applyEvent(emptyConversation(), event('ApprovalResolved', 1, { call_id: 'call-1', tool_name: 'shell', approved: false }))
    current = applyEvent(current, event('ToolFinished', 2, { call_id: 'call-1', tool_name: 'shell', result: { success: false, output: '用户拒绝执行' } }))
    current = applyEvent(current, event('TurnCancelled', 3))
    expect(current.messages[0]).toMatchObject({ status: 'denied', tool_finished: true })
  })

  it('does not finalize rows from a different turn of the same child agent', () => {
    const initial: Conversation = { ...emptyConversation(), summary: session, messages: [
      { id: 'old-child', role: 'tool', content: '', status: 'running', turn_id: 'turn-a', agent_id: 'worker', child_turn_id: 'child-turn-1' },
      { id: 'new-child', role: 'tool', content: '', status: 'running', turn_id: 'turn-a', agent_id: 'worker', child_turn_id: 'child-turn-2' }
    ] }
    const next = applyEvent(initial, event('TurnCancelled', 1, { child_turn_id: 'child-turn-2' }, 'worker'))
    expect(next.messages.map(message => message.status)).toEqual(['running', 'cancelled'])
    expect(next.summary?.status).toBe('running')
  })

  it.each([
    { success: false, output: '已中止', structured_output: { status: 'cancelled' } },
    { success: false, output: 'ExecutionStopped: user requested cancellation' }
  ])('recognizes cancelled tool results without presenting a failure', result => {
    const next = applyEvent(emptyConversation(), event('ToolFinished', 1, { call_id: 'call-1', tool_name: 'shell', result }))
    expect(next.messages[0]).toMatchObject({ status: 'cancelled', error: false, tool_finished: true })
  })
})
