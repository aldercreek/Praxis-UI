// Deterministic protocol peer used only by Electron integration tests.
const http = require('node:http')
const { spawn } = require('node:child_process')
const { readFileSync } = require('node:fs')
const { randomUUID } = require('node:crypto')
const directory = process.argv[process.argv.indexOf('--data-dir') + 1]
if (!directory || !process.env.PRAXIS_UI_TEST_MODE) throw new Error('Isolated fixture directory required')
if (process.argv.includes('--ensure')) {
  const args = process.argv.slice(1).filter(arg => arg !== '--ensure')
  const child = spawn(process.execPath, args, { env: process.env, detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
  let attempts = 0
  const timer = setInterval(() => {
    try {
      const text = readFileSync(require('node:path').join(directory, 'service.json'), 'utf8')
      clearInterval(timer)
      process.stdout.write(text)
    } catch {
      if (++attempts > 100) { clearInterval(timer); process.exitCode = 1 }
    }
  }, 50)
} else {
const replies = new Map()
const journals = new Map()
const token = randomUUID()
const instance = randomUUID()

const { existsSync, mkdirSync, realpathSync, writeFileSync } = require('node:fs')
const { isAbsolute, join, relative, resolve, sep } = require('node:path')
const { tmpdir } = require('node:os')
const sessions = new Map()
let bypass = process.argv.includes('--bypass')
let count = 0
const output = frame => {
  if (frame.id) { const reply = replies.get(frame.id); if (reply) { replies.delete(frame.id); reply(frame) }; return }
  const list = journals.get(frame.session_id) || []
  list.push(frame)
  journals.set(frame.session_id, list)
}
const summary = s => ({ id: s.id, title: s.title, workspace: s.workspace, model: 'test-model', updated_at: s.updated_at, active_turn: ['running', 'stopping'].includes(s.status) ? { id: s.turn, cancel_requested: s.status === 'stopping' } : null, latest_turn: s.turn ? { id: s.turn, status: s.status === 'idle' ? 'completed' : s.status === 'stopping' ? 'running' : s.status } : null })
const event = (s, name, data = {}, agent = 'main') => output({ event: name, session_id: s.id, turn_id: s.turn, agent_id: agent, sequence: ++s.sequence, data })
const updated = s => event(s, 'SessionUpdated', { session: summary(s) })
const finish = (s, status = 'idle') => {
  clearInterval(s.timer)
  s.timer = null
  s.status = status
  for (const approval of s.approvals) event(s, 'ApprovalClosed', { approval_id: approval.approval_id })
  s.approvals = []
  event(s, status === 'cancelled' ? 'TurnCancelled' : 'TurnCompleted')
  event(s, 'TurnSettled', { status })
  updated(s)
}
function respondText(s, text) {
  const id = `assistant:${s.turn}:main:1`
  const message = { id, role: 'assistant', content: '', turn_id: s.turn, agent_id: 'main', status: 'streaming' }
  s.messages.push(message)
  let position = 0
  s.timer = setInterval(() => {
    const delta = text.slice(position, position + 5)
    position += 5
    message.content += delta
    event(s, 'AssistantTextDelta', { request_number: 1, text: delta })
    if (position >= text.length) {
      message.status = 'completed'
      event(s, 'ModelRequestCompleted', { request_number: 1, output_text: text })
      event(s, 'AssistantTextCompleted', { text })
      finish(s)
    }
  }, 35)
}

function artifactWorkspace(s) {
  const configured = process.env.PRAXIS_UI_TEST_WORKSPACE
  if (process.env.PRAXIS_UI_TEST_MODE !== '1' || !configured) throw new Error('An isolated artifact test workspace is required')
  const root = realpathSync(configured)
  const fromTemporary = relative(realpathSync(tmpdir()), root)
  if (!fromTemporary || fromTemporary === '..' || fromTemporary.startsWith(`..${sep}`) || isAbsolute(fromTemporary)) {
    throw new Error('Artifact fixtures must stay inside an isolated temporary directory')
  }
  if (resolve(s.workspace).toLowerCase() !== resolve(root).toLowerCase()) throw new Error('Artifact session workspace does not match the test workspace')
  return root
}

function smallPdf() {
  const stream = 'BT /F1 14 Tf 24 100 Td (Praxis PDF preview fixture) Tj ET\n'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 160] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`
  ]
  let text = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(text))
    text += `${index + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = Buffer.byteLength(text)
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  text += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  text += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return text
}

function prepareArtifactFiles(s) {
  const root = artifactWorkspace(s)
  for (const directory of ['docs', 'src', 'images', 'files']) mkdirSync(join(root, directory), { recursive: true })
  if (!existsSync(join(root, 'docs', 'brief.md'))) writeFileSync(join(root, 'docs', 'brief.md'), '# Project notes\n\nStatus: draft.\n')
  writeFileSync(join(root, 'files', 'notes.txt'), 'Plain text preview fixture.\nThe second line stays readable.\n' + 'preview'.repeat(80) + '\n')
  writeFileSync(join(root, 'images', 'chart.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1kAAAAASUVORK5CYII=', 'base64'))
  writeFileSync(join(root, 'files', 'report.pdf'), smallPdf())
  // The unsupported-format path must never start an external Office process.
  writeFileSync(join(root, 'files', 'report.docx'), Buffer.from('PK\u0003\u0004Praxis unsupported Office preview fixture'))
  return root
}

function artifactTool(s, callId, path, before, after) {
  const root = artifactWorkspace(s)
  const oldLines = before ? before.replace(/\n$/, '').split('\n') : []
  const newLines = after ? after.replace(/\n$/, '').split('\n') : []
  let start = 0
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start += 1
  let end = 0
  while (end < oldLines.length - start && end < newLines.length - start
    && oldLines[oldLines.length - end - 1] === newLines[newLines.length - end - 1]) end += 1
  const removed = oldLines.slice(start, oldLines.length - end)
  const added = newLines.slice(start, newLines.length - end)
  const diff = [`--- a/${path}`, `+++ b/${path}`, `@@ -${start + 1},${removed.length} +${start + 1},${added.length} @@`,
    ...removed.map(line => `-${line}`), ...added.map(line => `+${line}`)].join('\n')
  const result = { success: true, output: `Updated ${path}.`, file_change: { path, diff, added: added.length, removed: removed.length } }
  const args = { relative_path: path, old_text: before, new_text: after }
  event(s, 'ToolCallPrepared', { call_id: callId, tool_name: 'edit_file', arguments: args })
  event(s, 'ToolStarted', { call_id: callId, tool_name: 'edit_file' })
  writeFileSync(join(root, path), after)
  event(s, 'ToolFinished', { call_id: callId, tool_name: 'edit_file', result })
  s.messages.push({ id: `tool:${s.turn}:main:${callId}`, role: 'tool', call_id: callId, tool_name: 'edit_file',
    content: result.output, turn_id: s.turn, agent_id: 'main', status: 'completed', tool_finished: true,
    arguments: args, file_change: result.file_change })
}

function finishArtifactTurn(s, text) {
  s.messages.push({ id: `assistant:${s.turn}:main:${s.turn}:1`, role: 'assistant', content: text,
    turn_id: s.turn, agent_id: 'main', status: 'completed' })
  event(s, 'ModelRequestCompleted', { request_number: 1, output_text: text })
  event(s, 'AssistantTextCompleted', { text })
  finish(s)
}

function artifactScenario(s, task) {
  const root = prepareArtifactFiles(s)
  if (task === '整理桌面交互方案') {
    writeFileSync(join(root, 'docs', 'interaction-notes.md'), '# 桌面交互方案\n\n将文件入口放在回答中，点击后在侧栏预览。\n\n[验收清单](../files/feature-checklist.csv)\n')
    writeFileSync(join(root, 'files', 'feature-checklist.csv'), '能力,状态\n文件预览,已完成\n引用追问,已完成\n')
    writeFileSync(join(root, 'docs', '桌面文件预览与引用追问交互说明-包含异常恢复与键盘操作的完整评审版本.md'), '# 完整交互说明\n\n长文件名仍然可以正常打开。\n')
    finishArtifactTurn(s, [
      '桌面交互方案已整理完成。文件预览、改动查看和引用追问都按同一套操作方式组织。',
      '可以先读[交互方案](docs/interaction-notes.md)，再对照清单检查实际体验。',
      '[交互方案](docs/interaction-notes.md) · [验收清单](files/feature-checklist.csv)',
      '[评审报告](files/report.pdf) · [完整交互说明](docs/桌面文件预览与引用追问交互说明-包含异常恢复与键盘操作的完整评审版本.md)',
      '选中回答中的一段文字，可以引用后继续提出修改意见。'
    ].join('\n\n'))
    return
  }
  if (task.includes('父子同名路径')) {
    artifactTool(s, 'parent-file', 'a.ts', '', 'export const source = "parent";\n')
    const agent = 'child-files'
    const childTurn = 'child-file-turn'
    const args = { relative_path: 'a.ts', content: 'export const source = "child";\n' }
    const result = { success: true, output: 'Updated a.ts in the child workspace.', file_change: {
      path: 'a.ts', diff: '--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1,1 @@\n+export const source = "child";', added: 1, removed: 0
    } }
    event(s, 'ToolCallPrepared', { call_id: 'child-file', tool_name: 'edit_file', arguments: args, child_turn_id: childTurn }, agent)
    event(s, 'ToolStarted', { call_id: 'child-file', tool_name: 'edit_file', child_turn_id: childTurn }, agent)
    event(s, 'ToolFinished', { call_id: 'child-file', tool_name: 'edit_file', result, child_turn_id: childTurn }, agent)
    s.messages.push({ id: `tool:${s.turn}:${agent}:child-file`, role: 'tool', call_id: 'child-file', tool_name: 'edit_file',
      content: result.output, turn_id: s.turn, agent_id: agent, child_turn_id: childTurn, status: 'completed', tool_finished: true,
      arguments: args, file_change: result.file_change })
    const text = '子任务的相对路径：[子任务 a.ts](<a.ts>)'
    event(s, 'ModelRequestCompleted', { request_number: 1, output_text: text, child_turn_id: childTurn }, agent)
    s.messages.push({ id: `assistant:${s.turn}:${agent}:${childTurn}:1`, role: 'assistant', content: text,
      turn_id: s.turn, agent_id: agent, child_turn_id: childTurn, status: 'completed' })
    finishArtifactTurn(s, '父任务与子任务各修改了自己的 a.ts。\n\n[主任务 a.ts](<a.ts>)')
    return
  }
  if (task.includes('第二轮')) {
    artifactTool(s, 'second-turn-change', 'src/settings.txt', 'mode=preview\n', 'mode=review\n')
    finishArtifactTurn(s, '第二轮只调整了配置文件。\n\n[配置文件](<src/settings.txt>)')
    return
  }
  artifactTool(s, 'brief-first', 'docs/brief.md', '# Project notes\n\nStatus: draft.\n', '# Project notes\n\nStatus: reviewed.\n')
  artifactTool(s, 'brief-second', 'docs/brief.md', '# Project notes\n\nStatus: reviewed.\n', '# Project notes\n\nStatus: final.\nOwner: Praxis.\n')
  artifactTool(s, 'settings', 'src/settings.txt', '', 'mode=preview\n')
  const absolute = join(root, 'files', 'notes.txt').replaceAll('\\', '/')
  const reply = [
    '文件已经准备好，可以检查结果并继续修改。',
    '引用测试：这段结论需要保留来源，并在后续消息中完整发送。',
    '[项目说明](<docs/brief.md>) · [纯文本](<files/notes.txt>) · [绝对路径文本](<' + absolute + '>)',
    '[图表图片](<images/chart.png>) · [PDF 报告](<files/report.pdf>) · [Office 文档](<files/report.docx>)',
    '[缺失文件](<files/missing.md>) · [配置文件](<src/settings.txt>)'
  ]
  if (task.includes('最小窗口')) {
    reply.push('长引用测试：' + Array.from({ length: 12 }, (_, index) => `第 ${index + 1} 项：检查文件预览、来源引用和任务结果，保留完整的参考内容，并确保展开详情以后仍然可以继续编辑和发送消息。`).join(''))
    event(s, 'PlanUpdated', { plan: [{ description: '准备预览文件', status: 'completed' }, { description: '核对结果并继续修改', status: 'pending' }] })
  }
  finishArtifactTurn(s, reply.join('\n\n'))
}

function dispatch(request) {
  const { id, method, params: p = {} } = request
  const reply = result => output({ id, result })
  const s = sessions.get(p.session_id)
  if (method === 'initialize') return reply({ protocol_version: 1, model: 'test-model', configured: true, bypass_approvals: bypass })
  if (method === 'session.list') return reply({ sessions: [...sessions.values()].filter(s => !p.workspace || s.workspace === p.workspace).map(summary) })
  if (method === 'session.create') {
    const s = { id: `session-${++count}`, title: '', workspace: p.workspace, updated_at: new Date().toISOString(), status: 'idle', messages: [], approvals: [], sequence: 0, turn: '', timer: null }
    sessions.set(s.id, s)
    updated(s)
    return reply({ session: summary(s) })
  }
  if (method === 'session.open') return reply({ session: summary(s), messages: s.messages, approvals: s.approvals, sequence: s.sequence })
  if (method === 'turn.start') {
    if (p.text.includes('测试延迟发送失败一次') && !s.delayedFailedSendOnce) {
      // The test releases this rejection through turn.input, so it can inspect
      // the in-flight draft without a timeout or a scheduling race.
      s.delayedFailedSendOnce = true
      s.pendingFailureId = id
      return
    }
    if (p.text.includes('测试发送失败一次') && !s.failedSendOnce) {
      s.failedSendOnce = true
      return output({ id, error: { code: 'fixture_rejection', message: '测试发送失败，请重试。' } })
    }
    const artifactTask = p.text.includes('产物验收') || p.text === '整理桌面交互方案'
    if (artifactTask) {
      try { artifactWorkspace(s) }
      catch (error) { return output({ id, error: { code: 'fixture_workspace', message: error.message } }) }
    }
    if (p.text.includes('诊断日志')) process.stderr.write('Fixture diagnostic emitted while sending a message.\n')
    s.title ||= p.text
    s.turn = `turn-${s.id}-${s.sequence}`
    s.status = 'running'
    reply({ turn_id: s.turn })
    updated(s)
    event(s, 'TurnStarted', { task: p.text })
    s.messages.push({ id: `user:${s.turn}`, role: 'user', content: p.text, turn_id: s.turn, agent_id: 'main', status: 'completed' })
    event(s, 'ModelRequestStarted', { request_number: 1 })
    if (artifactTask) {
      artifactScenario(s, p.text)
    } else if (p.text.includes('可控执行')) {
      // These turns advance only when an integration test sends test_events.
      // Avoid timers so assertions can observe every intermediate render.
    } else if (p.text.includes('工具展示')) {
      const introduction = '我先看看项目结构。'
      event(s, 'AssistantTextDelta', { request_number: 1, text: introduction })
      event(s, 'ModelRequestCompleted', { request_number: 1, output_text: introduction })
      const completedTool = (call_id, tool_name, args, output, success = true, extra = {}) => {
        event(s, 'ToolCallPrepared', { call_id, tool_name, arguments: args })
        event(s, 'ToolStarted', { call_id, tool_name })
        event(s, 'ToolFinished', { call_id, tool_name, result: { success, output, ...extra } })
      }
      completedTool('list', 'list_files', { relative_path: '.' }, 'src/\ntests/\nREADME.md\npyproject.toml')
      completedTool('readme', 'read_file', { relative_path: 'README.md' }, '# Praxis\nA local agent runtime.')
      completedTool('agent', 'read_file', { relative_path: 'src/praxis_agent/agent.py', start_line: 1, end_line: 80 }, 'class Agent:\n    def run(self, task):\n        return self.loop(task)')
      event(s, 'ModelRequestCompleted', { request_number: 2, output_text: '接下来调整工具摘要，并检查构建。' })
      completedTool('edit-app', 'edit_file', { relative_path: 'src/renderer/src/App.tsx' }, 'Updated tool summaries.', true, {
        file_change: { path: 'src/renderer/src/App.tsx', diff: '-<span>read_file</span>\n+<span>已读取 README.md</span>', added: 1, removed: 1 }
      })
      completedTool('edit-css', 'edit_file', { relative_path: 'src/renderer/src/styles.css' }, 'Updated summary spacing.')
      completedTool('build', 'run_command', { command: 'npm run build' }, 'Build completed.')
      completedTool('test', 'run_command', { command: 'npm test' }, 'Tests passed.')
      event(s, 'ModelRequestCompleted', { request_number: 3, output_text: '工具摘要已调整，正在检查桌面交互。' })
      const files = ['__init__.py', '__main__.py', 'agent.py', 'cli.py', 'config.py', 'events.py', 'execution.py', 'model.py', 'prompts.py', 'runtime.py', 'sessions.py', 'tool_execution.py', 'desktop/server.py', 'desktop/session_manager.py', 'desktop/event_adapter.py', 'desktop/protocol.py', 'tools/command.py', 'tools/registry.py']
      completedTool('command', 'run_command', { command: 'Get-ChildItem -Path src\\praxis_agent -Recurse -File -Filter *.py | Select-Object FullName, LastWriteTime, Length' }, files.map(path => `src/praxis_agent/${path}`).join('\n'))
      completedTool('failed', 'run_command', { command: 'Get-ChildItem -Path tests\\missing -Recurse -File' }, 'Cannot find path tests\\missing because it does not exist.', false)
      event(s, 'ToolCallPrepared', { call_id: 'live', tool_name: 'run_command', arguments: { command: 'python -m pytest tests -q' } })
      event(s, 'ToolStarted', { call_id: 'live', tool_name: 'run_command' })
      s.timer = setInterval(() => event(s, 'ToolOutputDelta', { call_id: 'live', tool_name: 'run_command', stream: 'stdout', text: 'Checking desktop protocol…\n' }), 400)
    } else if (p.text.includes('滚动测试')) {
      respondText(s, Array.from({ length: 30 }, (_, index) => `第 ${index + 1} 段：持续检查桌面会话中的消息滚动，保留用户正在阅读的位置。`).join('\n\n'))
    } else if (p.text.includes('长任务')) {
      event(s, 'AssistantTextDelta', { request_number: 1, text: '任务正在执行，可以继续补充要求。' })
      s.timer = setInterval(() => event(s, 'ToolOutputDelta', { call_id: 'stream', tool_name: 'run_command', stream: 'stdout', text: 'working\n' }), 500)
    } else if (p.text.includes('审批')) {
      const approval = { approval_id: `approval-${s.id}`, tool_name: 'run_command', arguments: { command: 'echo praxis' }, agent_id: 'main', turn_id: s.turn }
      event(s, 'ToolCallPrepared', { call_id: 'approved-tool', tool_name: approval.tool_name, arguments: approval.arguments, requires_approval: !bypass })
      if (bypass) {
        event(s, 'ToolStarted', { call_id: 'approved-tool', tool_name: approval.tool_name })
        event(s, 'ToolFinished', { call_id: 'approved-tool', tool_name: approval.tool_name, result: { success: true, output: 'praxis' } })
        respondText(s, 'Bypass 模式下已直接执行完成。')
      } else {
        s.approvals.push(approval)
        event(s, 'ApprovalPending', approval)
      }
    } else {
      event(s, 'PlanUpdated', { plan: [{ description: '检查工作区', status: 'completed' }, { description: '整理结果', status: 'in_progress' }] })
      respondText(s, '已完成这条独立会话中的任务。\n\n```python\nprint("Praxis")\n```')
    }
    return
  }
  if (method === 'turn.input') {
    if (typeof p.test_defer_inputs === 'boolean') {
      s.deferInputs = p.test_defer_inputs
      return reply({ deferred: s.deferInputs })
    }
    if (p.test_ack_state) return reply({ pending: Boolean(s?.pendingFailureId) })
    if (p.test_reject_pending_start) {
      const pendingId = s?.pendingFailureId
      if (!pendingId) return output({ id, error: { code: 'missing', message: 'No pending test request' } })
      s.pendingFailureId = undefined
      output({ id: pendingId, error: { code: 'fixture_rejection', message: '测试延迟发送失败，请重试。' } })
      return reply({ released: true })
    }
    if (Array.isArray(p.test_history)) {
      s.messages = p.test_history
      s.status = 'idle'
      return reply({ restored: true })
    }
    if (Array.isArray(p.test_events)) {
      if (!s) return output({ id, error: { code: 'missing', message: 'Test session not found' } })
      for (const frame of p.test_events) {
        const data = frame.data || {}
        if (frame.event === 'TurnSettled') s.status = data.status || 'idle'
        event(s, frame.event, data, frame.agent_id || 'main')
      }
      return reply({ sequence: s.sequence })
    }
    reply({ queued: true })
    if (s.deferInputs) return
    event(s, 'MessagesReceived', { source: 'user', items: [{ role: 'user', content: p.text }] })
    return
  }
  if (method === 'turn.stop') {
    s.status = 'stopping'
    updated(s)
    reply({ stopping: true })
    setTimeout(() => finish(s, 'cancelled'), 30)
    return
  }
  if (method === 'approval.respond') {
    const approval = s.approvals.find(a => a.approval_id === p.approval_id)
    if (!approval) return output({ id, error: { code: 'missing', message: '审批已结束' } })
    reply({})
    s.approvals = []
    event(s, 'ApprovalClosed', { approval_id: p.approval_id })
    event(s, 'ApprovalResolved', { call_id: 'approved-tool', tool_name: 'run_command', approved: p.approved })
    event(s, 'ToolFinished', { call_id: 'approved-tool', tool_name: 'run_command', result: { success: p.approved, output: p.approved ? 'praxis' : '用户拒绝执行' } })
    respondText(s, p.approved ? '操作已获得确认并执行完成。' : '已按你的要求拒绝执行。')
    return
  }
  output({ id, error: { code: 'method_not_found', message: method } })
}
let mcpScenario = 'normal'
const server = http.createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); res.end('{}'); return }
  const url = new URL(req.url, 'http://127.0.0.1')
  const parts = url.pathname.split('/').filter(Boolean)
  if (url.pathname === '/__mcp-test') { mcpScenario = url.searchParams.get('scenario'); res.end('{}'); return }
  if (url.pathname === '/api/mcp/servers') {
    res.setHeader('Content-Type', 'application/json')
    if (mcpScenario.endsWith('error')) { res.writeHead(503); res.end(JSON.stringify({ error: { message: 'MCP status unavailable' } })); return }
    if (mcpScenario.endsWith('empty')) { res.end(JSON.stringify({ servers: [] })); return }
    res.end(JSON.stringify({ servers: [
      { name: '数据库', state: 'connected' }, { name: '浏览器', state: 'connecting' },
      { name: '代码搜索', state: 'retrying' }, { name: '文档服务', state: 'disabled' }
    ] }))
    return
  }
  if (url.pathname === '/api/health') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ service: 'praxis', instance_id: instance, protocol_version: 1, ready: true, model: 'test-model', configured: !mcpScenario.startsWith('no-model'), bypass_approvals: bypass })); return }
  if (url.pathname === '/__shutdown') { res.end('{}'); setTimeout(() => process.exit(0), 20); return }
  if (parts[3] === 'events') {
    let cursor = Number(url.searchParams.get('after') || 0)
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    res.write('event: ready\ndata: {}\n\n')
    const timer = setInterval(() => {
      for (const event of journals.get(parts[2]) || []) {
        if (event.sequence > cursor) { res.write(`id: ${event.sequence}\nevent: ${event.event}\ndata: ${JSON.stringify(event)}\n\n`); cursor = event.sequence }
      }
    }, 10)
    req.on('close', () => clearInterval(timer))
    return
  }
  let raw = ''
  for await (const chunk of req) raw += chunk
  const p = raw ? JSON.parse(raw) : {}
  let method
  if (url.pathname === '/api/settings') { bypass = p.bypass_approvals ?? bypass; res.end(JSON.stringify({ configured: true })); return }
  if (parts[1] === 'approvals') {
    method = 'approval.respond'
    p.approval_id = parts[2]
    p.session_id = [...sessions.values()].find(s => s.approvals.some(a => a.approval_id === parts[2]))?.id
  } else if (parts.length === 2) {
    method = req.method === 'POST' ? 'session.create' : 'session.list'
    if (req.method === 'GET') p.workspace = url.searchParams.get('workspace')
  } else {
    p.session_id = parts[2]
    if (parts[3] === 'snapshot') method = 'session.open'
    else if (parts[3] === 'turns') method = 'turn.stop'
    else if (parts[3] === 'inputs') method = Object.keys(p).some(key => key.startsWith('test_')) || sessions.get(p.session_id)?.status === 'running' ? 'turn.input' : 'turn.start'
  }
  const id = randomUUID()
  replies.set(id, frame => { res.writeHead(frame.error ? 400 : 200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(frame.error ? { error: frame.error } : frame.result)) })
  dispatch({ id, method, params: p })
})
server.listen(0, '127.0.0.1', () => {
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'service.token'), token)
  writeFileSync(join(directory, 'service.json'), JSON.stringify({ port: server.address().port, instance_id: instance, protocol_version: 1, pid: process.pid }))
})
}
