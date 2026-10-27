import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PraxisEvent, SessionSnapshot, SessionSummary } from '../../shared/protocol'
import { applyEvent, applySnapshot, emptyConversation, type Conversation } from './state'

const session: SessionSummary = { id: 'session-a', title: 'Task A', workspace: '/work', model: 'test', status: 'running', updated_at: '2026-10-20T00:00:00Z' }
const event = (name: string, sequence: number, data: Record<string, unknown> = {}, agentId = 'main'): PraxisEvent => ({ event: name, session_id: session.id, turn_id: 'turn-a', agent_id: agentId, sequence, data })

describe('turn execution metadata', () => {
  afterEach(() => vi.restoreAllMocks())

  it('confirms an unchanged streamed final answer and preserves its finish time through cleanup', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
    const started = applyEvent({ ...emptyConversation(), summary: session }, event('TurnStarted', 1, { task: 'hello' }))
    let current = applyEvent(started, event('AssistantTextDelta', 2, { request_number: 1, text: 'answer' }))
    const answerId = current.messages.at(-1)!.id
    expect(current.turnsById['turn-a']).toEqual({ status: 'running', startedAt: 1000 })

    clock.mockReturnValue(2000)
    current = applyEvent(current, event('AssistantTextCompleted', 3, { text: 'answer' }))
    expect(current.messages.filter(message => message.role === 'assistant')).toEqual([
      expect.objectContaining({ id: answerId, content: 'answer', status: 'complete' })
    ])
    expect(current.turnsById['turn-a']).toEqual({ status: 'completed', startedAt: 1000, finishedAt: 2000, finalMessageId: answerId })
    expect(started.turnsById['turn-a']).toEqual({ status: 'running', startedAt: 1000 })
    expect(current.summary?.status).toBe('running')

    clock.mockReturnValue(5000)
    current = [event('TurnCompleted', 4), event('TurnSettled', 5, { status: 'idle' })].reduce(applyEvent, current)
    expect(current.turnsById['turn-a'].finishedAt).toBe(2000)
    expect(current.turnsById['turn-a'].finalMessageId).toBe(answerId)
    expect(current.summary?.status).toBe('idle')
  })

  it('does not classify a completed model response as the final answer', () => {
    let current = applyEvent(emptyConversation(), event('TurnStarted', 1, { task: 'Inspect the project' }))
    current = applyEvent(current, event('ModelRequestCompleted', 2, { request_number: 1, output_text: 'I will inspect the files.' }))
    expect(current.messages.at(-1)?.status).toBe('complete')
    expect(current.turnsById['turn-a']).toMatchObject({ status: 'running' })
    expect(current.turnsById['turn-a'].finalMessageId).toBeUndefined()
    expect(current.turnsById['turn-a'].finishedAt).toBeUndefined()
  })

  it('does not promote previous commentary when the final event has no answer text', () => {
    let current = applyEvent(emptyConversation(), event('TurnStarted', 1, { task: 'Inspect the project' }))
    current = applyEvent(current, event('ModelRequestCompleted', 2, { request_number: 1, output_text: 'I will inspect the files.' }))
    current = applyEvent(current, event('AssistantTextCompleted', 3, { text: '' }))
    expect(current.turnsById['turn-a'].status).toBe('completed')
    expect(current.turnsById['turn-a'].finalMessageId).toBeUndefined()
    expect(current.messages.at(-1)?.content).toBe('I will inspect the files.')
  })

  it.each(['AssistantTextCompleted', 'TurnCompleted', 'TurnFailed', 'TurnCancelled', 'TurnSettled'])('keeps the parent execution open when a child emits %s', name => {
    vi.spyOn(Date, 'now').mockReturnValue(1000)
    const started = applyEvent({ ...emptyConversation(), summary: session }, event('TurnStarted', 1, { task: 'parent' }))
    const childText = applyEvent(started, event('AssistantTextDelta', 2, { request_number: 1, child_turn_id: 'child-a', text: 'child answer' }, 'worker'))
    const next = applyEvent(childText, event(name, 3, { text: 'child answer', status: 'completed', child_turn_id: 'child-a' }, 'worker'))
    expect(next.turnsById).toBe(started.turnsById)
    expect(next.turnsById).toEqual({ 'turn-a': { status: 'running', startedAt: 1000 } })
    expect(next.summary?.status).toBe('running')
  })

  it.each([
    { name: 'TurnCancelled', status: 'cancelled' },
    { name: 'TurnFailed', status: 'failed' }
  ])('does not promote partial text to a final answer on $name', ({ name, status }) => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
    let current = applyEvent(emptyConversation(), event('TurnStarted', 1, { task: 'hello' }))
    current = applyEvent(current, event('AssistantTextDelta', 2, { request_number: 1, text: 'partial text' }))
    clock.mockReturnValue(2000)
    current = applyEvent(current, event(name, 3, { message: 'Request failed' }))
    expect(current.turnsById['turn-a']).toEqual({ status, startedAt: 1000, finishedAt: 2000 })
    expect(current.messages.at(-1)).toMatchObject({ role: 'system', turn_id: 'turn-a' })

    clock.mockReturnValue(5000)
    current = applyEvent(current, event('TurnSettled', 4, { status }))
    expect(current.turnsById['turn-a']).toEqual({ status, startedAt: 1000, finishedAt: 2000 })
  })

  it('tracks each turn independently when used directly as an Array.reduce callback', () => {
    vi.spyOn(Date, 'now').mockReturnValueOnce(1000).mockReturnValueOnce(2000).mockReturnValueOnce(3000).mockReturnValueOnce(4500)
    const current = [
      event('TurnStarted', 1, { task: 'first' }),
      event('TurnCompleted', 2),
      { ...event('TurnStarted', 3, { task: 'second' }), turn_id: 'turn-b' },
      { ...event('TurnCancelled', 4), turn_id: 'turn-b' }
    ].reduce(applyEvent, emptyConversation())
    expect(current.turnsById).toEqual({
      'turn-a': { status: 'completed', startedAt: 1000, finishedAt: 2000 },
      'turn-b': { status: 'cancelled', startedAt: 3000, finishedAt: 4500 }
    })
  })

  it('does not invent execution times or final markers from a completed snapshot', () => {
    const current = applySnapshot({ session: { ...session, status: 'idle' }, sequence: 5, approvals: [], messages: [
      { id: 'user', role: 'user', content: 'task', turn_id: 'turn-a', agent_id: 'main' },
      { id: 'answer', role: 'assistant', content: 'answer', turn_id: 'turn-a', agent_id: 'main', status: 'completed' }
    ] })
    expect(current.turnsById).toEqual({})
  })

  it('attaches child status messages to their parent turn for process grouping', () => {
    const current = applyEvent(emptyConversation(), event('ChildAgentStatus', 1, { task_summary: 'Inspect tests', status: 'running' }, 'worker'))
    expect(current.messages[0]).toMatchObject({ role: 'system', turn_id: 'turn-a', agent_id: 'worker', content: 'Inspect tests' })
  })

  it('keeps reused child status separate across parent turns and updates each row in place', () => {
    let current = applyEvent(emptyConversation(), event('ChildAgentStatus', 1, { task_summary: 'Inspect tests', status: 'running' }, 'worker'))
    current = applyEvent(current, event('ChildAgentStatus', 2, { status: 'idle' }, 'worker'))
    expect(current.messages).toHaveLength(1)
    expect(current.messages[0]).toMatchObject({ id: 'agent:turn-a:worker', content: 'Inspect tests', status: 'idle' })

    current = applyEvent(current, { ...event('ChildAgentStatus', 3, { task_summary: 'Review the fix', status: 'running' }, 'worker'), turn_id: 'turn-b' })
    const laterTurn = current.messages[1]
    current = applyEvent(current, event('ChildAgentStatus', 4, { status: 'closed' }, 'worker'))
    expect(current.messages).toHaveLength(2)
    expect(current.messages[0]).toMatchObject({ id: 'agent:turn-a:worker', turn_id: 'turn-a', content: 'Inspect tests', status: 'closed' })
    expect(current.messages[1]).toBe(laterTurn)
    expect(current.messages[1]).toMatchObject({ id: 'agent:turn-b:worker', turn_id: 'turn-b', content: 'Review the fix', status: 'running' })
  })
})

describe('conversation event reconciliation', () => {
  it('retains the previous turn plan and ignores child or late plans for the active progress bar', () => {
    const plan = [{ description: 'Inspect the project', status: 'in_progress' }]
    let current = applyEvent({ ...emptyConversation(), summary: session }, event('TurnStarted', 1, { task: 'first' }))
    current = applyEvent(current, event('PlanUpdated', 2, { plan }))
    current = applyEvent(current, { ...event('TurnStarted', 3, { task: 'next' }), turn_id: 'turn-b' })
    expect(current.plan).toEqual([])
    expect(current.plansByTurn['turn-a']).toEqual(plan)
    current = applyEvent(current, event('PlanUpdated', 4, { plan: [{ ...plan[0], status: 'completed' }] }))
    current = applyEvent(current, { ...event('PlanUpdated', 5, { plan }, 'worker'), turn_id: 'turn-b' })
    expect(current.plan).toEqual([])
    expect(current.activeTurnId).toBe('turn-b')
    expect(current.plansByTurn['turn-a'][0].status).toBe('completed')
    expect(current.plansByTurn['turn-b']).toBeUndefined()
  })

  it('restores the latest successful root plan per turn from saved tool calls', () => {
    const first = [{ description: 'Read the project', status: 'completed' }]
    const second = [{ description: 'Run tests', status: 'pending' }]
    const planCall = (id: string, turn: string, plan: typeof first, status = 'complete', agent = 'main') => ({
      id, turn_id: turn, role: 'tool' as const, tool_name: 'update_plan', content: '', arguments: { plan }, status, agent_id: agent
    })
    const restored = applySnapshot({ session: { ...session, status: 'idle' }, sequence: 6, approvals: [], messages: [
      planCall('plan-a', 'turn-a', first), planCall('plan-b', 'turn-b', second),
      planCall('failed-plan', 'turn-b', first, 'failed'), planCall('child-plan', 'turn-b', first, 'complete', 'worker')
    ] })
    expect(restored.plansByTurn).toEqual({ 'turn-a': first, 'turn-b': second })
    expect(restored.activeTurnId).toBe('turn-b')
    expect(restored.plan).toEqual(second)
  })

  it('does not mark pending steps complete when a turn settles', () => {
    let current = applyEvent({ ...emptyConversation(), summary: session }, event('PlanUpdated', 1, {
      plan: [{ step: 'Inspect files', status: 'completed' }, { description: 'Run tests', status: 'pending' }]
    }))
    current = applyEvent(current, event('TurnSettled', 2, { status: 'completed' }))
    expect(current.plan.map(step => step.status)).toEqual(['completed', 'pending'])
    expect(current.plansByTurn['turn-a']).toEqual(current.plan)
  })

  it('applies a successful plan call before its metadata event so a duplicate tool row need not flash', () => {
    const plan = [{ step: 'Inspect files', status: 'in_progress' }]
    let current = applyEvent(emptyConversation(), event('ToolCallPrepared', 1, { call_id: 'plan', tool_name: 'update_plan', arguments: { plan } }))
    expect(current.plan).toEqual([])
    current = applyEvent(current, event('ToolFinished', 2, { call_id: 'plan', tool_name: 'update_plan', result: { success: true, output: 'Plan updated.' } }))
    expect(current.plan).toEqual([{ description: 'Inspect files', status: 'in_progress' }])
    expect(current.plansByTurn['turn-a']).toEqual(current.plan)
    current = applyEvent(current, event('ToolCallPrepared', 3, { call_id: 'invalid-plan', tool_name: 'update_plan', arguments: { plan: [{ step: 'Invalid', status: 'completed' }] } }))
    current = applyEvent(current, event('ToolFinished', 4, { call_id: 'invalid-plan', tool_name: 'update_plan', result: { success: false, output: 'Rejected' } }))
    expect(current.plan).toEqual([{ description: 'Inspect files', status: 'in_progress' }])
  })

  it('restores cold history without turn IDs and excludes calls without a successful result', () => {
    const earlier = [{ step: 'Read files', status: 'completed' }]
    const current = [{ step: 'Check tests', status: 'pending' }]
    const messages = [
      { id: 'message-1', role: 'user' as const, content: 'First task', agent_id: 'main' },
      { id: 'message-2', role: 'tool' as const, content: 'Plan updated.', agent_id: 'main', tool_name: 'update_plan', status: 'completed', tool_finished: true, arguments: { plan: earlier } },
      { id: 'message-3', role: 'user' as const, content: 'Next task', agent_id: 'main' },
      { id: 'message-4', role: 'tool' as const, content: 'Plan updated.', agent_id: 'main', tool_name: 'update_plan', status: 'completed', tool_finished: true, arguments: { plan: current } },
      { id: 'message-5', role: 'tool' as const, content: '', agent_id: 'main', tool_name: 'update_plan', status: 'completed', tool_finished: false, arguments: { plan: earlier } }
    ]
    const snapshot: SessionSnapshot = { session: { ...session, status: 'idle' }, messages, approvals: [], sequence: 0 }
    const restored = applySnapshot(snapshot)
    expect(restored.activeTurnId).toBe('history:session-a:message-3')
    expect(restored.plan).toEqual([{ description: 'Check tests', status: 'pending' }])
    expect(restored.plansByTurn['history:session-a:message-1']).toEqual([{ description: 'Read files', status: 'completed' }])
    expect(restored.messages.at(-1)?.status).toBe('cancelled')
    expect(applySnapshot(snapshot).plansByTurn).toEqual(restored.plansByTurn)
    expect(snapshot.messages[0].turn_id).toBeUndefined()
  })

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
