import { describe, expect, it } from 'vitest'
import type { PraxisEvent, SessionSummary } from '../../shared/protocol'
import { applyEvent, applySnapshot, emptyConversation, type Conversation } from './state'
import { agentKey, agentStatusLabel, collectAgents, mainAgentMessages } from './agentPresentation'

const session: SessionSummary = { id: 's', title: 'Task', workspace: '/work', model: 'test', status: 'running', updated_at: '', active_turn: { id: 'parent', cancel_requested: false } }
const frame = (event: string, data: Record<string, unknown> = {}, agent_id = 'reviewer', turn_id = 'parent'): PraxisEvent => ({ event, data, agent_id, turn_id })
const run = (...events: PraxisEvent[]) => events.reduce(applyEvent, { ...emptyConversation(), summary: session } as Conversation)
const envelope = (content: string) => '[Agent collaboration messages; source-labelled task data]\n' + JSON.stringify([{ sender_id: 'parent', recipient_id: 'reviewer', content }])

describe('agent dock and continuous activity', () => {
  it('keeps task instructions, tool activity and responses in order and removes the report echo', () => {
    const state = run(frame('ChildAgentStatus', { status: 'running', task_summary: 'Review queue' }),
      frame('TurnStarted', { task: envelope('Inspect delivery.'), child_turn_id: 'run-1' }),
      frame('ModelRequestCompleted', { request_number: 1, output_text: 'Checking now.', child_turn_id: 'run-1' }),
      frame('ToolCallPrepared', { call_id: 'read', tool_name: 'read_file', arguments: { relative_path: 'queue.py' } }),
      frame('ModelRequestCompleted', { request_number: 2, output_text: '**Found** a blocker.', child_turn_id: 'run-1' }),
      frame('TurnCompleted', { child_turn_id: 'run-1' }),
      frame('ChildAgentMessage', { content: '[Worker run ended; this does not imply task completion. Read the response for findings, blockers or requests for reassignment.]\n**Found** a blocker.\nWorking directory: /work. Files are not automatically integrated into the parent workspace.' }))
    const [task] = collectAgents(state)
    expect(task.messages.map(message => message.content)).toEqual(['Inspect delivery.', 'Checking now.', '', '**Found** a blocker.'])
    expect(agentStatusLabel(task)).toBe('Returned')
    expect(mainAgentMessages(state)).toEqual([])
  })

  it('scopes the same agent ID to its parent turn, including approval state', () => {
    const state = run(frame('ChildAgentStatus', { status: 'idle', task_summary: 'Old review' }, 'reviewer', 'old'),
      frame('ChildAgentStatus', { status: 'running', task_summary: 'New review' }),
      frame('ApprovalPending', { approval_id: 'a', tool_name: 'run_command', arguments: {} }))
    expect(collectAgents(state).map(task => [task.key, agentStatusLabel(task)])).toEqual([
      [agentKey('parent', 'reviewer'), 'Needs approval'], [agentKey('old', 'reviewer'), 'Returned']])
  })

  it('preserves failure through worker cleanup but permits a new run', () => {
    let state = run(frame('TurnStarted', { task: 'First', child_turn_id: 'one' }), frame('TurnFailed', { message: 'offline', child_turn_id: 'one' }), frame('ChildAgentStatus', { status: 'idle' }))
    expect(collectAgents(state)[0].status).toBe('failed')
    state = applyEvent(state, frame('TurnStarted', { task: 'Retry', child_turn_id: 'two' }))
    state = applyEvent(state, frame('TurnCancelled', { child_turn_id: 'one' }))
    expect(collectAgents(state)[0].status).toBe('running')
    state = applyEvent(state, frame('AssistantTextCompleted', { text: 'Retry result', child_turn_id: 'two' }))
    expect(collectAgents(state)[0].messages.some(message => message.content === 'offline')).toBe(true)
    expect(collectAgents(state)[0].messages.at(-1)?.content).toBe('Retry result')
  })

  it('does not overwrite the previous run response when a follow-up completes without deltas', () => {
    const state = run(frame('AssistantTextCompleted', { text: 'First answer', child_turn_id: 'one' }),
      frame('TurnStarted', { task: 'Follow up', child_turn_id: 'two' }),
      frame('AssistantTextCompleted', { text: 'Second answer', child_turn_id: 'two' }))
    expect(collectAgents(state)[0].messages.map(message => message.content)).toEqual(['First answer', 'Follow up', 'Second answer'])
  })

  it('restores lifecycle facts from the journal without duplicating projected content', () => {
    const events = [frame('ChildAgentStatus', { status: 'running', task_summary: 'Review' }), frame('TurnStarted', { task: 'Inspect', child_turn_id: 'r' }),
      frame('TurnFailed', { message: 'Unavailable', child_turn_id: 'r' }), frame('ChildAgentStatus', { status: 'closed' }), frame('TurnSettled', { status: 'idle' }, 'main')]
    const live = run(...events)
    const snapshot = applySnapshot({ session: { ...session, status: 'idle', active_turn: null }, messages: live.messages, approvals: [], sequence: 5, view_events: events })
    expect(collectAgents(snapshot)).toEqual(collectAgents(live))
    expect(collectAgents(snapshot)[0].status).toBe('failed')
  })

  it('stops active workers on cancellation without changing already returned workers', () => {
    const state = run(frame('ChildAgentStatus', { status: 'running' }), frame('ChildAgentStatus', { status: 'idle' }, 'writer'), frame('TurnCancelled', {}, 'main'))
    expect(collectAgents(state).map(task => task.status)).toEqual(['stopped', 'returned'])
  })

  it('keeps failed and unmatched orchestration visible while hiding represented coordination', () => {
    const state = run(frame('ChildAgentStatus', { status: 'idle' }))
    state.messages.push(...[
      { id: 'spawn', role: 'tool' as const, tool_name: 'spawn_agent', status: 'completed', content: '{"agent_id":"reviewer"}', turn_id: 'parent' },
      { id: 'missing', role: 'tool' as const, tool_name: 'close_agent', status: 'completed', content: '{"agent_id":"missing"}', turn_id: 'parent' },
      { id: 'failed', role: 'tool' as const, tool_name: 'send_messages', status: 'failed', content: '{"agent_id":"reviewer"}', turn_id: 'parent' }])
    expect(mainAgentMessages(state).map(message => message.id)).toEqual(['missing', 'failed'])
  })

  it('retains partial delivery failures even when the batch tool succeeded', () => {
    const state = run(frame('ChildAgentStatus', { status: 'idle' }))
    state.messages.push({ id: 'batch', role: 'tool', tool_name: 'send_messages', status: 'completed', turn_id: 'parent',
      arguments: { messages: [{ agent_id: 'reviewer', content: 'Review again' }] },
      content: JSON.stringify({ results: [{ agent_id: 'reviewer', accepted: false, error: 'Worker closed' }] }) })
    expect(mainAgentMessages(state).map(message => message.id)).toEqual(['batch'])
  })

  it('does not infer success from an incomplete historical worker', () => {
    const state = applySnapshot({ session: { ...session, status: 'idle', active_turn: null }, messages: [{ id: 'agent:parent:reviewer', role: 'system', content: 'Review', status: 'running', agent_id: 'reviewer', turn_id: 'parent' }], approvals: [], sequence: 1 })
    expect(agentStatusLabel(collectAgents(state)[0])).toBe('Not running')
  })
})
