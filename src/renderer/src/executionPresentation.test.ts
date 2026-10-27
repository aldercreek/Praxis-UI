import { describe, expect, it } from 'vitest'
import { emptyConversation, type Conversation } from './state'
import { presentExecution } from './executionPresentation'

const active = (): Conversation => ({ ...emptyConversation(), activeTurnId: 'current',
  summary: { id: 'chat', title: 'Task', workspace: '.', model: 'test', updated_at: '', status: 'running' } })

describe('execution status', () => {
  it('keeps the current step stable through short tool/model handoffs', () => {
    const conversation = { ...active(), plan: [{ description: '梳理模块结构', status: 'in_progress' }] }
    for (const activity of ['Thinking', 'Using read_file', 'Running']) {
      expect(presentExecution({ ...conversation, activity })).toEqual({ label: '梳理模块结构', tone: 'working' })
    }
  })

  it('does not let older background commands replace the current turn status', () => {
    const conversation = active()
    conversation.messages = [{ id: 'old', role: 'tool', content: '', tool_name: 'run_command', status: 'running', turn_id: 'older' }]
    expect(presentExecution(conversation).label).toBe('Working…')
    conversation.messages.push({ id: 'new', role: 'tool', content: '', tool_name: 'read_file', status: 'running', turn_id: 'current' })
    expect(presentExecution(conversation).label).toBe('Reading project files…')
  })

  it('prioritizes approval and stopping over progress', () => {
    const conversation = active()
    conversation.approvals = [{ approval_id: 'approval', tool_name: 'run_command', arguments: {} }]
    expect(presentExecution(conversation)).toEqual({ label: 'Awaiting approval', tone: 'attention' })
    conversation.summary!.status = 'stopping'
    expect(presentExecution(conversation).label).toBe('Stopping…')
  })

  it('reports the turn outcome without claiming unfinished steps succeeded', () => {
    const conversation = active()
    conversation.plan = [{ description: 'Run tests', status: 'pending' }]
    conversation.summary!.status = 'idle'
    expect(presentExecution(conversation).label).toBe('Task completed')
    conversation.summary!.status = 'failed'
    expect(presentExecution(conversation)).toEqual({ label: 'Task failed', tone: 'failed' })
    conversation.summary!.status = 'cancelled'
    expect(presentExecution(conversation).label).toBe('Stopped')
  })
})
