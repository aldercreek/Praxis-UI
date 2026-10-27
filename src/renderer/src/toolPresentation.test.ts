import { describe, expect, it } from 'vitest'
import type { DisplayMessage } from './state'
import { groupTranscript, presentTool, type ToolGroup } from './toolPresentation'

const read = (id: string, patch: Partial<DisplayMessage> = {}): DisplayMessage => ({
  id, role: 'tool', content: 'file contents', tool_name: 'read_file',
  status: 'complete', turn_id: 'turn-1', agent_id: 'main', ...patch
})

describe('tool summaries', () => {
  it('shows Praxis relative paths, including Windows paths and requested line ranges', () => {
    const tool = presentTool(read('read', { arguments: { relative_path: 'src\\praxis_agent\\agent.py', start_line: 10, end_line: 40 } }))
    expect(tool).toMatchObject({ summary: 'Read src/praxis_agent/agent.py:10–40', kind: 'read', fullTarget: 'src/praxis_agent/agent.py:10–40' })
    expect(presentTool(read('legacy', { arguments: { file_path: 'README.md' } })).target).toBe('README.md')
  })

  it('keeps full multiline commands available behind the one-line preview', () => {
    const command = 'Get-ChildItem -Path src\nWrite-Output done'
    expect(presentTool(read('command', { tool_name: 'run_command', arguments: { command } })))
      .toMatchObject({ summary: 'Ran Get-ChildItem -Path src', kind: 'command', fullTarget: command, command })
  })

  it('distinguishes waiting, failed, denied and stopped work from a completed action', () => {
    const cases = [
      ['pending', 'Queued: Write App.tsx'], ['approval', 'Awaiting approval: Write App.tsx'], ['failed', 'Failed to write App.tsx'],
      ['denied', 'Rejected: Write App.tsx'], ['cancelled', 'Stopped: Write App.tsx']
    ] as const
    for (const [status, summary] of cases) {
      expect(presentTool(read(status, { tool_name: 'write_file', arguments: { relative_path: 'App.tsx' }, status }))).toMatchObject({ summary, running: false })
    }
    expect(presentTool(read('error', { error: true })).status).toBe('Failed')
    expect(presentTool(read('running', { status: 'running', arguments: { path: 'README.md' } }))).toMatchObject({ summary: 'Reading README.md', running: true })
    expect(presentTool(read('unknown', { status: undefined })).status).toBe('Unknown')
  })

  it('preserves unknown tool identities and shows search scope without inventing results', () => {
    expect(presentTool(read('search', { tool_name: 'search_text', arguments: { pattern: 'class Agent', relative_path: 'src' } })))
      .toMatchObject({ summary: 'Searched class Agent (src)', kind: 'search' })
    expect(presentTool(read('external', { tool_name: 'mcp__docs__lookup', arguments: { query: 'desktop UI' } })))
      .toMatchObject({ summary: 'Called mcp__docs__lookup · desktop UI', kind: 'tool' })
    expect(presentTool(read('inherited-key', { tool_name: 'constructor' }))).toMatchObject({ summary: 'Called constructor', kind: 'tool' })
  })

  it('names internal discovery and planning actions without exposing their implementation names in the summary', () => {
    const cases = [
      ['search_tools', { query: 'codegraph' }, 'Searched tools codegraph'],
      ['activate_tools', { tool_names: ['mcp__codegraph__search'] }, 'Enabled tools'],
      ['update_plan', { plan: [{ step: '检查文件', status: 'in_progress' }] }, 'Updated plan']
    ] as const
    for (const [tool_name, args, summary] of cases) {
      expect(presentTool(read(tool_name, { tool_name, arguments: args }))).toMatchObject({ name: tool_name, summary })
    }
  })
})

const groups = (messages: DisplayMessage[], planTurnIds?: ReadonlySet<string>): ToolGroup[] =>
  groupTranscript(messages, planTurnIds).filter((item): item is ToolGroup => item.role === 'tool-group')

describe('stable activity groups', () => {
  it('uses the same group from the first call through additions and out-of-order completion', () => {
    let messages = [read('a', { status: 'running', tool_finished: false, arguments: { path: 'a.ts' } })]
    const groupId = groups(messages)[0].id
    expect(groups(messages)[0]).toMatchObject({
      id: 'group:a', role: 'tool-group', messages
    })
    for (const message of [
      read('b', { status: 'pending', tool_finished: false, tool_name: 'run_command', arguments: { command: 'npm test' } }),
      read('c', { status: 'pending', tool_finished: false, tool_name: 'edit_file', arguments: { path: 'c.ts' } })
    ]) {
      messages = [...messages, message]
      expect(groups(messages).map(group => group.id)).toEqual([groupId])
      expect(groups(messages)[0].messages).toEqual(messages)
    }
    for (const id of ['c', 'a', 'b']) {
      messages = messages.map(message => message.id === id ? { ...message, status: 'complete', tool_finished: true, content: `${id} result` } : message)
      const result = groups(messages)
      expect(result).toHaveLength(1)
      expect(result[0].id).toBe(groupId)
      expect(result[0].messages.map(message => message.id)).toEqual(['a', 'b', 'c'])
      expect(result[0].messages.find(message => message.id === id)?.content).toBe(`${id} result`)
    }
    expect(groups(messages)[0].messages.map(message => message.content)).toEqual(['a result', 'b result', 'c result'])
  })

  it('keeps the parent and member order for every execution status', () => {
    for (const status of ['pending', 'running', 'complete', 'failed', 'approval', 'denied', 'cancelled', undefined]) {
      const messages = [read('a'), read('b', { status, tool_finished: false }), read('c')]
      const result = groups(messages)
      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('group:a')
      expect(result[0].messages).toEqual(messages)
    }
  })

  it('retains each failure and approval on its own tool without an aggregate summary', () => {
    const messages = [
      read('failed', { status: 'failed', arguments: { path: 'missing.ts' } }),
      read('approval', { status: 'approval', arguments: { path: 'private.ts' } }),
      read('denied', { status: 'denied', arguments: { path: 'denied.ts' } }),
      read('cancelled', { status: 'cancelled', arguments: { path: 'cancelled.ts' } }),
      read('running', { status: 'running' })
    ]
    const group = groups(messages)[0]
    expect(group).toEqual({ id: 'group:failed', role: 'tool-group', messages })
    expect(group.messages.map(message => presentTool(message).status)).toEqual(['Failed', 'Awaiting approval', 'Denied', 'Stopped', 'Running'])
  })

  it('keeps mixed tool categories and external tool identities in the same continuous stage', () => {
    const messages = [
      read('list', { tool_name: 'list_files' }), read('read'),
      read('search', { tool_name: 'search_text' }), read('discover', { tool_name: 'search_tools' }),
      read('activate', { tool_name: 'activate_tools' }),
      read('command', { tool_name: 'run_command' }), read('wait', { tool_name: 'wait_command' }),
      read('edit', { tool_name: 'edit_file' }), read('write', { tool_name: 'write_file' }),
      read('external-a', { tool_name: 'mcp__docs__lookup' }), read('external-b', { tool_name: 'mcp__docs__lookup' }),
      read('other', { tool_name: 'mcp__search__lookup' }), read('image', { tool_name: 'view_image' })
    ]
    const result = groups(messages)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('group:list')
    expect(result.flatMap(group => group.messages)).toEqual(messages)
  })

  it('does not report a yielded background command or a nonzero exit as completed', () => {
    const yielded = read('command', { tool_name: 'run_command', structured_output: { status: 'running', session_id: 'cmd-1' } })
    expect(presentTool(groups([yielded])[0].messages[0])).toMatchObject({ running: true, status: 'Running' })
    const failed = read('failed-command', { tool_name: 'run_command', arguments: { command: 'npm test' }, structured_output: { exit_code: 1 } })
    expect(presentTool(groups([failed])[0].messages[0])).toMatchObject({ running: false, status: 'Failed' })
    expect(presentTool(failed).summary).toBe('Failed to run npm test')
  })

  it('retains the background command and all output polling records', () => {
    const messages = [
      read('command', { tool_name: 'run_command', tool_finished: true, structured_output: { session_id: 'cmd-1', status: 'exited', exit_code: 0 } }),
      read('wait-1', { tool_name: 'wait_command', tool_finished: true, structured_output: { session_id: 'cmd-1', status: 'exited', exit_code: 0 } }),
      read('wait-2', { tool_name: 'wait_command', tool_finished: true, structured_output: { session_id: 'cmd-1', status: 'exited', exit_code: 0 } })
    ]
    expect(groups(messages)[0].messages).toEqual(messages)
    expect(groups(messages.slice(1))[0].messages).toEqual(messages.slice(1))
  })

  it('preserves repeated reads and their requested line ranges', () => {
    const messages = [
      read('first-part', { arguments: { relative_path: 'src\\App.tsx', start_line: 1, end_line: 40 } }),
      read('second-part', { arguments: { path: 'src/App.tsx', start_line: 41, end_line: 80 } }),
      read('other-file', { arguments: { file_path: 'src/styles.css' } })
    ]
    expect(groups(messages)[0].messages).toEqual(messages)
    expect(groups([...messages, read('unknown-path')])[0].messages).toHaveLength(4)
  })

  it('never merges across messages, turns, agents or child executions', () => {
    const boundaries: Partial<DisplayMessage>[] = [
      { role: 'assistant' }, { role: 'user' }, { role: 'system' },
      { turn_id: 'turn-2' }, { agent_id: 'worker' }, { child_turn_id: 'child-2' }
    ]
    for (const boundary of boundaries) {
      const messages = [read('a'), read('b'), read('boundary', boundary), read('c'), read('d')]
      const result = groupTranscript(messages)
      expect(result).toHaveLength(3)
      expect(result[0]).toMatchObject({ id: 'group:a', messages: messages.slice(0, 2) })
      expect(result[2]).toMatchObject({ id: 'group:c', messages: messages.slice(3) })
      if (boundary.role) expect(result[1]).toEqual(messages[2])
    }
    expect(groups([read('root', { agent_id: 'root' }), read('main')])).toHaveLength(1)
  })
})

describe('plan tool deduplication', () => {
  const planTurns = new Set(['turn-1'])
  const plan = (patch: Partial<DisplayMessage> = {}) => read('plan', { tool_name: 'update_plan', ...patch })

  it('suppresses transient planning metadata and hides success only when that turn has plan data', () => {
    for (const status of ['pending', 'running']) expect(groupTranscript([plan({ status })])).toEqual([])
    expect(groups([plan()])[0]).toMatchObject({ id: 'group:plan', messages: [plan()] })
    expect(groupTranscript([plan()], planTurns)).toEqual([])
    expect(groups([plan({ turn_id: 'turn-2' })], planTurns)).toHaveLength(1)
    expect(groups([plan({ agent_id: 'worker' })], planTurns)).toHaveLength(1)
  })

  it('retains failures, approvals, denials and stopped plan calls even with plan data', () => {
    for (const status of ['failed', 'approval', 'denied', 'cancelled']) {
      const message = plan({ status })
      expect(groups([message], planTurns)[0]).toEqual({ id: 'group:plan', role: 'tool-group', messages: [message] })
    }
    expect(presentTool(groups([plan({ error: true })], planTurns)[0].messages[0]).status).toBe('Failed')
  })

  it('keeps a hidden plan inside the surrounding stage and retains its original group key', () => {
    for (const status of ['pending', 'running', 'complete']) {
      const result = groups([read('before'), plan({ status }), read('after', { tool_name: 'run_command' })], planTurns)
      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('group:before')
      expect(result[0].messages.map(message => message.id)).toEqual(['before', 'after'])
      expect(groups([plan({ status }), read('after')], planTurns)[0].id).toBe('group:plan')
    }
    const failed = plan({ id: 'later-plan', status: 'failed' })
    expect(groups([plan(), failed], planTurns)[0]).toMatchObject({
      id: 'group:plan', messages: [failed]
    })
  })
})
