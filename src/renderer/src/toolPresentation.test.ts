import { describe, expect, it } from 'vitest'
import type { DisplayMessage } from './state'
import { groupTranscript, presentTool } from './toolPresentation'

const read = (id: string, patch: Partial<DisplayMessage> = {}): DisplayMessage => ({
  id, role: 'tool', content: 'file contents', tool_name: 'read_file',
  status: 'complete', turn_id: 'turn-1', agent_id: 'main', ...patch
})

describe('tool summaries', () => {
  it('shows Praxis relative paths, including Windows paths and requested line ranges', () => {
    const tool = presentTool(read('read', { arguments: { relative_path: 'src\\praxis_agent\\agent.py', start_line: 10, end_line: 40 } }))
    expect(tool).toMatchObject({ label: 'Read', target: 'agent.py:10–40', context: 'src/praxis_agent', fullTarget: 'src\\praxis_agent\\agent.py' })
    expect(presentTool(read('legacy', { arguments: { file_path: 'README.md' } })).target).toBe('README.md')
  })

  it('keeps full multiline commands available behind the one-line preview', () => {
    const command = 'Get-ChildItem -Path src\nWrite-Output done'
    expect(presentTool(read('command', { tool_name: 'run_command', arguments: { command } })))
      .toMatchObject({ label: 'Ran', target: 'Get-ChildItem -Path src', fullTarget: command, command })
  })

  it('distinguishes waiting, failed, denied and stopped work from a completed action', () => {
    const cases = [['pending', 'Queued'], ['approval', 'Awaiting approval'], ['failed', 'Failed'], ['denied', 'Denied'], ['cancelled', 'Stopped']] as const
    for (const [status, expected] of cases) {
      expect(presentTool(read(status, { tool_name: 'write_file', status }))).toMatchObject({ label: 'Write', status: expected, running: false })
    }
    expect(presentTool(read('error', { error: true })).status).toBe('Failed')
    expect(presentTool(read('running', { status: 'running' }))).toMatchObject({ label: 'Reading', running: true })
    expect(presentTool(read('unknown', { status: undefined })).status).toBe('Unknown')
  })

  it('preserves unknown tool identities and shows search scope without inventing results', () => {
    expect(presentTool(read('search', { tool_name: 'search_text', arguments: { pattern: 'class Agent', relative_path: 'src' } })))
      .toMatchObject({ label: 'Searched', target: 'class Agent', context: 'src' })
    expect(presentTool(read('external', { tool_name: 'mcp__docs__lookup', arguments: { query: 'desktop UI' } })))
      .toMatchObject({ label: 'mcp__docs__lookup', target: 'desktop UI' })
  })
})

describe('collapsing completed exploration', () => {
  it('keeps every original call in order and leaves commands, changes and errors visible', () => {
    const reads = [read('list', { tool_name: 'list_files' }), read('a'), read('b')]
    const standalone = [read('command', { tool_name: 'run_command' }), read('edit', { tool_name: 'edit_file' }), read('failed', { error: true }), read('active', { status: 'running' })]
    const items = groupTranscript([...reads, ...standalone])
    expect(items).toEqual([{ id: 'group:list', role: 'tool-group', messages: reads }, ...standalone])
  })

  it('never merges across messages, turns, agents or child executions', () => {
    const boundaries: Partial<DisplayMessage>[] = [
      { role: 'assistant' }, { turn_id: 'turn-2' }, { agent_id: 'worker' }, { child_turn_id: 'child-2' },
      { status: 'approval' }, { status: 'pending' }, { status: 'cancelled' }, { status: undefined }
    ]
    for (const boundary of boundaries) {
      const messages = [read('a'), read('b'), read('boundary', boundary), read('c'), read('d')]
      expect(groupTranscript(messages)).toEqual(messages)
    }
  })
})
