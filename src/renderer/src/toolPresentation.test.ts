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
    expect(tool).toMatchObject({ summary: '已读取 src/praxis_agent/agent.py:10–40', kind: 'read', fullTarget: 'src/praxis_agent/agent.py:10–40' })
    expect(presentTool(read('legacy', { arguments: { file_path: 'README.md' } })).target).toBe('README.md')
  })

  it('keeps full multiline commands available behind the one-line preview', () => {
    const command = 'Get-ChildItem -Path src\nWrite-Output done'
    expect(presentTool(read('command', { tool_name: 'run_command', arguments: { command } })))
      .toMatchObject({ summary: '已运行 Get-ChildItem -Path src', kind: 'command', fullTarget: command, command })
  })

  it('distinguishes waiting, failed, denied and stopped work from a completed action', () => {
    const cases = [
      ['pending', '等待写入 App.tsx'], ['approval', '等待确认：写入 App.tsx'], ['failed', '写入失败：App.tsx'],
      ['denied', '已拒绝写入 App.tsx'], ['cancelled', '已停止写入 App.tsx']
    ] as const
    for (const [status, summary] of cases) {
      expect(presentTool(read(status, { tool_name: 'write_file', arguments: { relative_path: 'App.tsx' }, status }))).toMatchObject({ summary, running: false })
    }
    expect(presentTool(read('error', { error: true })).status).toBe('Failed')
    expect(presentTool(read('running', { status: 'running', arguments: { path: 'README.md' } }))).toMatchObject({ summary: '正在读取 README.md', running: true })
    expect(presentTool(read('unknown', { status: undefined })).status).toBe('Unknown')
  })

  it('preserves unknown tool identities and shows search scope without inventing results', () => {
    expect(presentTool(read('search', { tool_name: 'search_text', arguments: { pattern: 'class Agent', relative_path: 'src' } })))
      .toMatchObject({ summary: '已搜索 class Agent （src）', kind: 'search' })
    expect(presentTool(read('external', { tool_name: 'mcp__docs__lookup', arguments: { query: 'desktop UI' } })))
      .toMatchObject({ summary: '已调用 mcp__docs__lookup · desktop UI', kind: 'tool' })
    expect(presentTool(read('inherited-key', { tool_name: 'constructor' }))).toMatchObject({ summary: '已调用 constructor', kind: 'tool' })
  })
})

describe('grouping completed actions', () => {
  it('keeps every original call in order and leaves errors and running work visible', () => {
    const reads = [read('list', { tool_name: 'list_files' }), read('a'), read('b')]
    const standalone = [read('failed', { error: true }), read('active', { status: 'running' })]
    const items = groupTranscript([...reads, ...standalone])
    expect(items).toEqual([{ id: 'group:list', role: 'tool-group', summary: '已浏览目录并读取文件 · 3 项操作', kind: 'read', messages: reads }, ...standalone])
  })

  it('counts operations on the same file and never invents a successful test outcome', () => {
    const edits = [read('a'), read('b')].map(message => ({ ...message, tool_name: 'edit_file', arguments: { relative_path: 'App.tsx' } }))
    const commands = [read('build', { tool_name: 'run_command', arguments: { command: 'npm run build' } }), read('test', { tool_name: 'run_command', arguments: { command: 'npm test' } })]
    expect(groupTranscript([...edits, ...commands])).toEqual([
      { id: 'group:a', role: 'tool-group', summary: '已编辑文件并运行命令 · 4 项操作', kind: 'edit', messages: [...edits, ...commands] }
    ])
  })

  it('does not hide a yielded background command or a nonzero exit behind completion', () => {
    for (const structured_output of [{ status: 'running', session_id: 'cmd-1' }, { status: 'exited', exit_code: 1 }]) {
      const messages = [read('a'), read('b'), read('command', { tool_name: 'run_command', structured_output }), read('c')]
      expect(groupTranscript(messages)).toEqual(messages)
    }
    expect(presentTool(read('failed-command', { tool_name: 'run_command', arguments: { command: 'npm test' }, structured_output: { exit_code: 1 } })).summary).toBe('运行失败：npm test')
  })

  it('never merges across messages, turns, agents or child executions', () => {
    const boundaries: Partial<DisplayMessage>[] = [
      { role: 'assistant' }, { role: 'user' }, { turn_id: 'turn-2' }, { agent_id: 'worker' }, { child_turn_id: 'child-2' },
      { status: 'approval' }, { status: 'pending' }, { status: 'cancelled' }, { status: 'denied' }, { status: 'failed' }, { status: undefined },
      { tool_name: 'mcp__docs__lookup' }, { tool_finished: false }
    ]
    for (const boundary of boundaries) {
      const messages = [read('a'), read('b'), read('boundary', boundary), read('c'), read('d')]
      expect(groupTranscript(messages)).toEqual(messages)
    }
  })
})
