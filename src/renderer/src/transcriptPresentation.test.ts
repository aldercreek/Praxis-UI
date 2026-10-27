import { describe, expect, it } from 'vitest'
import type { PraxisEvent, SessionSummary } from '../../shared/protocol'
import { applyEvent, emptyConversation, type Conversation, type DisplayMessage } from './state'
import { completedLabel, isProcessItem, presentTranscript, processLabel, visibleBodyIds } from './transcriptPresentation'

const session: SessionSummary = {
  id: 'session-a', title: 'Task', workspace: '/work', model: 'test', status: 'idle', updated_at: '2026-10-25T00:00:00Z'
}
const message = (id: string, role: DisplayMessage['role'], patch: Partial<DisplayMessage> = {}): DisplayMessage => ({
  id, role, content: id, turn_id: 'turn-a', agent_id: 'main', status: 'complete', ...patch
})
const tool = (id: string, patch: Partial<DisplayMessage> = {}) => message(id, 'tool', { tool_name: 'read_file', ...patch })
const conversation = (messages: DisplayMessage[], patch: Partial<Conversation> = {}): Conversation => ({
  ...emptyConversation(), summary: session, messages, activeTurnId: 'turn-a', ...patch
})

describe('turn transcript presentation', () => {
  it.each([
    ['TurnCompleted', 'completed'], ['TurnFailed', 'failed'], ['TurnCancelled', 'cancelled']
  ])('keeps %s cleanup visible until settlement without changing its final result or duration', (terminalEvent, status) => {
    const event = (name: string, sequence: number, data: Record<string, unknown> = {}): PraxisEvent => ({
      event: name, sequence, session_id: session.id, turn_id: 'turn-a', agent_id: 'main', data
    })
    let current = applyEvent(conversation([], { summary: { ...session, active_turn: { id: 'turn-a', cancel_requested: false } } }),
      event('TurnStarted', 1, { task: 'Inspect the project' }))
    current = applyEvent(current, event('AssistantTextDelta', 2, { request_number: 1, text: 'The result.' }))
    if (status === 'completed') {
      current = applyEvent(current, event('AssistantTextCompleted', 3, { text: 'The result.' }))
      expect(presentTranscript(current)[0]).toMatchObject({ running: true, finalMessageId: current.messages.at(-1)!.id })
    }
    current = applyEvent(current, event(terminalEvent, 4, { message: 'Request failed' }))
    const finished = { ...current.turnsById['turn-a'] }
    expect(finished.status).toBe(status)
    expect(finished.finishedAt).toBeDefined()
    expect(presentTranscript(current)[0]).toMatchObject({ running: true, outcome: status })

    current = applyEvent(current, event('TurnSettled', 5, { status }))
    expect(presentTranscript(current)[0]).toMatchObject({ running: false, outcome: status })
    expect(current.turnsById['turn-a']).toEqual(finished)
  })

  it('does not reopen a settled process when the next active turn arrives before its start event', () => {
    const finished = { status: 'completed' as const, startedAt: 1000, finishedAt: 2000, finalMessageId: 'answer' }
    const current = conversation([message('request', 'user'), tool('read'), message('answer', 'assistant')], {
      turnsById: { 'turn-a': finished }
    })
    const next = applyEvent(current, { event: 'SessionUpdated', sequence: 1, session_id: session.id, data: {
      session: { ...session, status: 'running', active_turn: { id: 'turn-b', cancel_requested: false } }
    } })
    expect(next.activeTurnId).toBe('turn-a')
    expect(presentTranscript(next)[0]).toMatchObject({ running: false, finalMessageId: 'answer', outcome: 'completed' })
    expect(next.turnsById['turn-a']).toBe(finished)
  })

  it('keeps live prose and completed model responses inside the process until a final message is confirmed', () => {
    const messages = [message('request', 'user'), message('progress', 'assistant'), tool('read'), message('response', 'assistant', { status: 'streaming' })]
    const current = conversation(messages, {
      summary: { ...session, status: 'running' }, turnsById: { 'turn-a': { status: 'running', startedAt: 1000 } }
    })
    let turn = presentTranscript(current)[0]
    expect(turn).toMatchObject({ id: 'turn-a', running: true, hasProcess: true })
    expect(turn.finalMessageId).toBeUndefined()
    expect(turn.items.filter(item => isProcessItem(item, turn.finalMessageId)).map(item => item.id)).toEqual(['progress', 'group:read', 'response'])

    turn = presentTranscript({ ...current, summary: session, turnsById: { 'turn-a': { status: 'completed', startedAt: 1000, finishedAt: 5000 } } })[0]
    expect(turn.running).toBe(false)
    expect(turn.finalMessageId).toBeUndefined()
  })

  it('preserves stage boundaries and shows only the explicitly confirmed final answer outside the process', () => {
    const messages = [
      message('request', 'user'), message('inspect', 'assistant'), tool('read'), tool('command', { tool_name: 'run_command' }),
      message('verify', 'assistant'), tool('edit', { tool_name: 'edit_file' }), message('answer', 'assistant')
    ]
    const turn = presentTranscript(conversation(messages, {
      turnsById: { 'turn-a': { status: 'completed', startedAt: 1000, finishedAt: 5000, finalMessageId: 'answer' } }
    }))[0]
    expect(turn).toMatchObject({ id: 'turn-a', finalMessageId: 'answer', hasProcess: true, running: false })
    expect(turn.items.map(item => item.id)).toEqual(['request', 'inspect', 'group:read', 'verify', 'group:edit', 'answer'])
    expect(turn.items.filter(item => !isProcessItem(item, turn.finalMessageId)).map(item => item.id)).toEqual(['request', 'answer'])
  })

  it('does not use child answers as the main final and keeps child tool groups separate', () => {
    const messages = [
      message('request', 'user'), tool('main-read'), tool('child-read', { agent_id: 'worker', child_turn_id: 'child-a' }),
      message('answer', 'assistant'), message('child-answer', 'assistant', { agent_id: 'worker', child_turn_id: 'child-a' })
    ]
    const turn = presentTranscript(conversation(messages))[0]
    expect(turn.finalMessageId).toBe('answer')
    expect(turn.items.filter(item => item.role === 'tool-group').map(item => item.id)).toEqual(['group:main-read', 'group:child-read'])
    expect(isProcessItem(messages.at(-1)!, turn.finalMessageId)).toBe(true)
    const childOnly = presentTranscript(conversation([message('request', 'user'), tool('main-read'), messages.at(-1)!]))[0]
    expect(childOnly.finalMessageId).toBeUndefined()
  })

  it('keeps completed historical answers visible without inventing execution metadata or elapsed time', () => {
    const messages = [message('request', 'user'), message('progress', 'assistant'), tool('read'), message('answer', 'assistant')]
    const turn = presentTranscript(conversation(messages))[0]
    expect(turn.finalMessageId).toBe('answer')
    expect(turn.execution).toBeUndefined()
    expect(turn.outcome).toBe('completed')
    expect(processLabel(turn.execution)).toBe('Process')
    expect(turn.items.filter(item => !isProcessItem(item, turn.finalMessageId)).map(item => item.id)).toEqual(['request', 'answer'])
  })

  it('does not treat the last interim answer before a main tool as a historical final', () => {
    const turn = presentTranscript(conversation([message('request', 'user'), message('progress', 'assistant'), tool('read')]))[0]
    expect(turn.finalMessageId).toBeUndefined()
    expect(turn.hasProcess).toBe(true)
  })

  it('does not infer a final answer from a running snapshot with no local metadata', () => {
    const turn = presentTranscript(conversation([message('request', 'user'), tool('read'), message('response', 'assistant')], {
      summary: { ...session, status: 'running' }
    }))[0]
    expect(turn).toMatchObject({ running: true, hasProcess: true })
    expect(turn.finalMessageId).toBeUndefined()
    expect(turn.execution).toBeUndefined()
  })

  it('keeps a historical process folded while a new turn is waiting for its start event', () => {
    const turns = presentTranscript(conversation([
      message('request', 'user'), message('progress', 'assistant'), tool('read'), message('answer', 'assistant'),
      message('new-request', 'user', { turn_id: undefined, status: 'sending' })
    ], { summary: { ...session, status: 'running' } }))
    expect(turns[0]).toMatchObject({ running: false, finalMessageId: 'answer', hasProcess: true })
    expect(turns[1].items.map(item => item.id)).toEqual(['new-request'])
  })

  it.each(['failed', 'cancelled'] as const)('keeps %s notices visible without promoting interrupted text to a final answer', status => {
    const notice = message('notice', 'system', { status, error: status === 'failed' })
    const messages = [message('request', 'user'), tool('read'), message('partial', 'assistant'), notice]
    const executions: Conversation['turnsById'][] = [{}, { 'turn-a': { status, startedAt: 1000, finishedAt: 5000 } }]
    for (const turnsById of executions) {
      const turn = presentTranscript(conversation(messages, { summary: { ...session, status }, turnsById }))[0]
      expect(turn.finalMessageId).toBeUndefined()
      expect(turn.running).toBe(false)
      expect(turn.outcome).toBe(status)
      expect(isProcessItem(notice, turn.finalMessageId)).toBe(false)
      expect(turn.items.filter(item => !isProcessItem(item, turn.finalMessageId)).map(item => item.id)).toEqual(['request', 'notice'])
    }
  })

  it.each(['failed', 'cancelled'] as const)('labels a reopened %s turn from its session summary without inventing execution timing', status => {
    const turn = presentTranscript(conversation([message('request', 'user'), tool('read'), message('partial', 'assistant')], {
      summary: { ...session, status }
    }))[0]
    expect(turn.outcome).toBe(status)
    expect(turn.execution).toBeUndefined()
    expect(turn.finalMessageId).toBeUndefined()
    expect(completedLabel({ status: turn.outcome })).toBe(status === 'failed' ? 'Failed' : 'Cancelled')
  })

  it.each(['failed', 'cancelled'] as const)('uses the matching latest turn status without applying it to older turns: %s', status => {
    const turns = presentTranscript(conversation([
      message('old-request', 'user'), message('old-answer', 'assistant'),
      message('request', 'user', { turn_id: 'turn-b' }), message('partial', 'assistant', { turn_id: 'turn-b' })
    ], { activeTurnId: 'turn-b', summary: { ...session, latest_turn: { id: 'turn-b', status } } }))
    expect(turns.map(turn => turn.outcome)).toEqual(['completed', status])
    expect(turns.map(turn => turn.finalMessageId)).toEqual(['old-answer', undefined])
    expect(turns.every(turn => turn.execution === undefined)).toBe(true)
  })

  it('does not treat recoverable tool or child failures as a failed root turn', () => {
    const turn = presentTranscript(conversation([
      message('request', 'user'), tool('failed-tool', { status: 'failed', error: true }),
      message('child-error', 'system', { agent_id: 'worker', error: true, status: 'failed' }),
      message('answer', 'assistant')
    ]))[0]
    expect(turn.outcome).toBe('completed')
    expect(turn.finalMessageId).toBe('answer')
  })

  it('prefers observed execution status over stale snapshot metadata', () => {
    const turn = presentTranscript(conversation([message('request', 'user'), tool('read'), message('answer', 'assistant')], {
      summary: { ...session, status: 'failed', latest_turn: { id: 'turn-a', status: 'failed' } },
      turnsById: { 'turn-a': { status: 'completed', finalMessageId: 'answer' } }
    }))[0]
    expect(turn.outcome).toBe('completed')
    expect(turn.finalMessageId).toBe('answer')
  })

  it.each([{ error: true }, { status: 'failed' }, { status: 'cancelled' }])('uses a historical interruption notice even when that turn is no longer the active session turn: %j', notice => {
    const messages = [
      message('old-request', 'user'), tool('old-read'), message('partial', 'assistant'), message('old-error', 'system', notice),
      message('new-request', 'user', { turn_id: 'turn-b' }), message('new-answer', 'assistant', { turn_id: 'turn-b' })
    ]
    const turns = presentTranscript(conversation(messages, { activeTurnId: 'turn-b' }))
    expect(turns.map(turn => turn.id)).toEqual(['turn-a', 'turn-b'])
    expect(turns[0].finalMessageId).toBeUndefined()
    expect(turns[0].outcome).toBe(notice.status === 'cancelled' ? 'cancelled' : 'failed')
    expect(turns[1].finalMessageId).toBe('new-answer')
  })

  it('leaves child failures and cancellations visible while folding routine child status', () => {
    const child = { agent_id: 'worker', child_turn_id: 'child-a' }
    expect(isProcessItem(message('child-error', 'system', { ...child, error: true }))).toBe(false)
    expect(isProcessItem(message('child-stop', 'system', { ...child, status: 'cancelled' }))).toBe(false)
    expect(isProcessItem(message('child-ready', 'system', { ...child, status: 'completed' }))).toBe(true)
  })

  it('always leaves supplementary user messages outside the process and preserves their order', () => {
    const messages = [
      message('request', 'user'), tool('read'), message('supplement', 'user'),
      tool('command', { tool_name: 'run_command' }), message('answer', 'assistant')
    ]
    const turn = presentTranscript(conversation(messages, {
      turnsById: { 'turn-a': { status: 'completed', finalMessageId: 'answer' } }
    }))[0]
    expect(turn.items.map(item => item.id)).toEqual(['request', 'group:read', 'supplement', 'group:command', 'answer'])
    expect(turn.items.filter(item => !isProcessItem(item, turn.finalMessageId)).map(item => item.id)).toEqual(['request', 'supplement', 'answer'])
  })

  it('does not create an empty process around a simple final answer or empty streamed placeholders', () => {
    const turn = presentTranscript(conversation([
      message('request', 'user'), message('placeholder', 'assistant', { content: ' \n ' }), message('answer', 'assistant')
    ]))[0]
    expect(turn.finalMessageId).toBe('answer')
    expect(turn.hasProcess).toBe(false)
    expect(turn.items.map(item => item.id)).toEqual(['request', 'answer'])
  })
})

describe('process elapsed time', () => {
  it('requires both observed timestamps before showing a duration', () => {
    expect(processLabel()).toBe('Process')
    expect(processLabel({ status: 'running', startedAt: 1000 })).toBe('Process')
    expect(processLabel({ status: 'completed', finishedAt: 5000 })).toBe('Process')
  })

  it('formats known seconds, minutes and hours from the recorded turn duration', () => {
    expect(processLabel({ status: 'completed', startedAt: 1000, finishedAt: 46000 })).toBe('Elapsed 45s')
    expect(processLabel({ status: 'completed', startedAt: 1000, finishedAt: 76000 })).toBe('Elapsed 1m 15s')
    expect(processLabel({ status: 'completed', startedAt: 1000, finishedAt: 3661000 })).toBe('Elapsed 1h 1m')
  })
})

describe('completed conversation reading anchors', () => {
  const bodies = [
    message('request', 'user'), message('intro', 'assistant', { content: 'I will inspect the files.' }), tool('read'),
    message('analysis', 'assistant', { content: 'The service broadcasts session creation correctly, but the desktop applies events without checking which session they belong to.' }),
    tool('edit', { tool_name: 'edit_file' }), message('answer', 'assistant', { content: 'The session check is fixed.' }),
    message('child-answer', 'assistant', { agent_id: 'worker', content: 'A child result. '.repeat(40) })
  ]

  it('keeps the longest main explanation and last main reply without treating a child reply as an anchor', () => {
    const turn = presentTranscript(conversation(bodies, { turnsById: { 'turn-a': { status: 'completed', finalMessageId: 'answer' } } }))[0]
    expect([...visibleBodyIds(turn)]).toEqual(['analysis', 'answer'])
    expect(turn.finalMessageId).toBe('answer')
    expect(turn.items.map(item => item.id)).toEqual(['request', 'intro', 'group:read', 'analysis', 'group:edit', 'answer', 'child-answer'])
  })

  it('leaves all main prose visible while the turn is still active', () => {
    const turn = presentTranscript(conversation(bodies, {
      summary: { ...session, status: 'running' }, turnsById: { 'turn-a': { status: 'running' } }
    }))[0]
    expect([...visibleBodyIds(turn)]).toEqual(['intro', 'analysis', 'answer'])
  })

  it.each(['failed', 'cancelled'] as const)('retains useful partial %s prose without inventing a confirmed final answer', status => {
    const turn = presentTranscript(conversation([
      ...bodies.slice(0, -2), message('partial', 'assistant', { content: 'The next check is incomplete.' }),
      message('notice', 'system', { status, error: status === 'failed' })
    ], { summary: { ...session, status }, turnsById: { 'turn-a': { status } } }))[0]
    expect([...visibleBodyIds(turn)]).toEqual(['analysis', 'partial'])
    expect(turn.finalMessageId).toBeUndefined()
    expect(isProcessItem(turn.items.at(-1)!)).toBe(false)
  })

  it('ignores whitespace, retains equally long anchors, and allows turns without main prose', () => {
    const turn = presentTranscript(conversation([
      message('padded', 'assistant', { content: '      x      ' }),
      message('first', 'assistant', { content: 'equal' }), message('second', 'assistant', { content: 'equal' }),
      message('empty', 'assistant', { content: '  \n ' }), message('last', 'assistant', { content: 'ok' })
    ]))[0]
    expect([...visibleBodyIds(turn)]).toEqual(['first', 'second', 'last'])
    expect([...visibleBodyIds(presentTranscript(conversation([message('request', 'user'), tool('read')]))[0])]).toEqual([])
  })
})

describe('completed status labels', () => {
  it('reports actual outcomes without inventing missing timing', () => {
    expect(completedLabel()).toBe('Completed')
    expect(completedLabel({ status: 'completed', startedAt: 1000 })).toBe('Completed')
    expect(completedLabel({ status: 'failed', finishedAt: 2000 })).toBe('Failed')
    expect(completedLabel({ status: 'cancelled' })).toBe('Cancelled')
    expect(completedLabel({ status: 'running', startedAt: 1000 })).toBe('Running')
  })

  it('formats observed durations without rounding the turn up to an extra second', () => {
    expect(completedLabel({ status: 'completed', startedAt: 1000, finishedAt: 30999 })).toBe('Completed 29s')
    expect(completedLabel({ status: 'failed', startedAt: 1000, finishedAt: 76000 })).toBe('Failed 1m15s')
    expect(completedLabel({ status: 'cancelled', startedAt: 1000, finishedAt: 3661000 })).toBe('Cancelled 1h1m')
    expect(completedLabel({ status: 'completed', startedAt: 1000, finishedAt: 61000 })).toBe('Completed 1m')
    expect(completedLabel({ status: 'completed', startedAt: 1000, finishedAt: 1500 })).toBe('Completed <1s')
    expect(completedLabel({ status: 'completed', startedAt: 1000, finishedAt: 1000 })).toBe('Completed 0s')
  })

  it('omits invalid or reversed timestamps', () => {
    expect(completedLabel({ status: 'failed', startedAt: 2000, finishedAt: 1000 })).toBe('Failed')
    expect(completedLabel({ status: 'cancelled', startedAt: Number.NaN, finishedAt: 1000 })).toBe('Cancelled')
    expect(completedLabel({ status: 'completed', startedAt: 1000, finishedAt: Number.POSITIVE_INFINITY })).toBe('Completed')
  })
})
