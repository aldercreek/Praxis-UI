import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '../../shared/protocol'
import { emptyConversation, type Conversation, type DisplayMessage } from './state'
import { isProcessItem, presentTranscript, processLabel } from './transcriptPresentation'

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
    expect(processLabel(turn.execution)).toBe('执行过程')
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
      expect(isProcessItem(notice, turn.finalMessageId)).toBe(false)
      expect(turn.items.filter(item => !isProcessItem(item, turn.finalMessageId)).map(item => item.id)).toEqual(['request', 'notice'])
    }
  })

  it.each([{ error: true }, { status: 'failed' }])('uses a historical interruption notice even when that turn is no longer the active session turn: %j', notice => {
    const messages = [
      message('old-request', 'user'), tool('old-read'), message('partial', 'assistant'), message('old-error', 'system', notice),
      message('new-request', 'user', { turn_id: 'turn-b' }), message('new-answer', 'assistant', { turn_id: 'turn-b' })
    ]
    const turns = presentTranscript(conversation(messages, { activeTurnId: 'turn-b' }))
    expect(turns.map(turn => turn.id)).toEqual(['turn-a', 'turn-b'])
    expect(turns[0].finalMessageId).toBeUndefined()
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
    expect(processLabel()).toBe('执行过程')
    expect(processLabel({ status: 'running', startedAt: 1000 })).toBe('执行过程')
    expect(processLabel({ status: 'completed', finishedAt: 5000 })).toBe('执行过程')
  })

  it('formats known seconds, minutes and hours from the recorded turn duration', () => {
    expect(processLabel({ status: 'completed', startedAt: 1000, finishedAt: 46000 })).toBe('用时 45 秒')
    expect(processLabel({ status: 'completed', startedAt: 1000, finishedAt: 76000 })).toBe('用时 1 分 15 秒')
    expect(processLabel({ status: 'completed', startedAt: 1000, finishedAt: 3661000 })).toBe('用时 1 小时 1 分')
  })
})
