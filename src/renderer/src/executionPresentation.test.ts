import { describe, expect, it } from 'vitest'
import { emptyConversation, type Conversation } from './state'
import { presentExecution } from './executionPresentation'

const active = (): Conversation => ({ ...emptyConversation(), activeTurnId: 'current',
  summary: { id: 'chat', title: 'Task', workspace: '.', model: 'test', updated_at: '', status: 'running' } })

describe('execution feedback visibility', () => {
  it('uses one plain waiting label and leaves task steps in the plan', () => {
    const conversation = { ...active(), plan: [{ description: 'Inspect modules', status: 'in_progress' }] }
    for (const activity of ['Thinking', 'Using read_file', 'Running']) {
      expect(presentExecution({ ...conversation, activity })).toEqual({ label: 'Working', tone: 'working' })
    }
  })

  it('suppresses the footer for current visible actions, including parallel and background commands', () => {
    const conversation = active()
    conversation.messages = [{ id: 'old', role: 'tool', content: '', tool_name: 'run_command', status: 'running', turn_id: 'older' }]
    expect(presentExecution(conversation)?.label).toBe('Working')
    for (const tool_name of ['read_file', 'search_text', 'run_command', 'mcp_docs_lookup', 'view_image']) {
      for (const status of ['running', 'pending']) {
        conversation.messages[1] = { id: 'current', role: 'tool', content: '', tool_name, status, turn_id: 'current' }
        expect(presentExecution(conversation)).toBeUndefined()
      }
    }
    conversation.messages[1].status = 'complete'
    expect(presentExecution(conversation)?.label).toBe('Working')
    conversation.messages[1] = { ...conversation.messages[1], tool_name: 'run_command', structured_output: { status: 'running', session_id: 'shell' } }
    expect(presentExecution(conversation)).toBeUndefined()
  })

  it('does not let a hidden plan action or another agent suppress main-thread waiting', () => {
    const conversation = active()
    conversation.messages = [
      { id: 'plan', role: 'tool', content: '', tool_name: 'update_plan', status: 'running', turn_id: 'current' },
      { id: 'child', role: 'tool', content: '', tool_name: 'read_file', status: 'running', turn_id: 'current', agent_id: 'worker' }
    ]
    expect(presentExecution(conversation)?.label).toBe('Working')
  })

  it('shows waiting until visible text arrives and again when the next model request starts', () => {
    const conversation = active()
    conversation.activity = 'Responding'
    conversation.messages = [{ id: 'response', role: 'assistant', content: '[message_id=m', status: 'streaming', turn_id: 'current' }]
    expect(presentExecution(conversation)?.label).toBe('Working')
    conversation.messages[0].content = '[message_id=m1] Inspecting the results.'
    expect(presentExecution(conversation)).toBeUndefined()
    conversation.activity = 'Thinking'
    expect(presentExecution(conversation)?.label).toBe('Working')
    conversation.activity = 'Responding'
    conversation.messages.push({ id: 'next-response', role: 'assistant', content: '[message_id=m', status: 'streaming', turn_id: 'current' })
    expect(presentExecution(conversation)?.label).toBe('Working')
  })

  it('keeps approvals in their card and reports stopping immediately without punctuation', () => {
    const conversation = active()
    conversation.approvals = [{ approval_id: 'approval', tool_name: 'run_command', arguments: {} }]
    expect(presentExecution(conversation)).toBeUndefined()
    conversation.approvals = []
    conversation.summary!.status = 'stopping'
    expect(presentExecution(conversation)?.label).toBe('Stopping')
    conversation.turnsById.current = { status: 'cancelled' }
    expect(presentExecution(conversation)).toBeUndefined()
  })

  it('ends execution feedback when the final response or outcome arrives, before cleanup settles', () => {
    for (const status of ['completed', 'failed', 'cancelled'] as const) {
      const conversation = active()
      conversation.activity = 'Finishing task'
      conversation.turnsById.current = { status }
      expect(presentExecution(conversation)).toBeUndefined()
    }
    for (const status of ['idle', 'failed', 'cancelled'] as const) {
      const conversation = active()
      conversation.summary!.status = status
      expect(presentExecution(conversation)).toBeUndefined()
    }
  })
})
