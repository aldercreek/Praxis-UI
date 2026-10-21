// Deterministic protocol peer used only by Electron integration tests.
const readline = require('node:readline')
const sessions = new Map()
let count = 0
const output = frame => process.stdout.write(JSON.stringify(frame) + '\n')
const summary = s => ({ id: s.id, title: s.title, workspace: s.workspace, model: 'test-model', updated_at: s.updated_at, status: s.status })
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
const input = readline.createInterface({ input: process.stdin })
input.on('line', line => {
  const request = JSON.parse(line)
  const { id, method, params: p = {} } = request
  const reply = result => output({ id, result })
  const s = sessions.get(p.session_id)
  if (method === 'initialize') return reply({ protocol_version: 1, model: 'test-model', configured: true })
  if (method === 'session.list') return reply({ sessions: [...sessions.values()].filter(s => s.workspace === p.workspace).map(summary) })
  if (method === 'session.create') {
    const s = { id: `session-${++count}`, title: '', workspace: p.workspace, updated_at: new Date().toISOString(), status: 'idle', messages: [], approvals: [], sequence: 0, turn: '', timer: null }
    sessions.set(s.id, s)
    updated(s)
    return reply({ session: summary(s) })
  }
  if (method === 'session.open') return reply({ session: summary(s), messages: s.messages, approvals: s.approvals, sequence: s.sequence })
  if (method === 'turn.start') {
    s.title ||= p.text
    s.turn = `turn-${s.id}-${s.sequence}`
    s.status = 'running'
    reply({ turn_id: s.turn })
    updated(s)
    event(s, 'TurnStarted', { task: p.text })
    s.messages.push({ id: `user:${s.turn}`, role: 'user', content: p.text, turn_id: s.turn, agent_id: 'main', status: 'completed' })
    event(s, 'ModelRequestStarted', { request_number: 1 })
    if (p.text.includes('长任务')) {
      event(s, 'AssistantTextDelta', { request_number: 1, text: '任务正在执行，可以继续补充要求。' })
      s.timer = setInterval(() => event(s, 'ToolOutputDelta', { call_id: 'stream', tool_name: 'run_command', stream: 'stdout', text: 'working\n' }), 500)
    } else if (p.text.includes('审批')) {
      const approval = { approval_id: `approval-${s.id}`, tool_name: 'run_command', arguments: { command: 'echo praxis' }, agent_id: 'main', turn_id: s.turn }
      s.approvals.push(approval)
      event(s, 'ToolCallPrepared', { call_id: 'approved-tool', tool_name: approval.tool_name, arguments: approval.arguments, requires_approval: true })
      event(s, 'ApprovalPending', approval)
    } else {
      event(s, 'PlanUpdated', { plan: [{ description: '检查工作区', status: 'completed' }, { description: '整理结果', status: 'in_progress' }] })
      respondText(s, '已完成这条独立会话中的任务。\n\n```python\nprint("Praxis")\n```')
    }
    return
  }
  if (method === 'turn.input') {
    reply({ queued: true })
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
  if (method === 'shutdown') {
    for (const s of sessions.values()) clearInterval(s.timer)
    reply({})
    input.close()
    setTimeout(() => process.exit(0), 10)
    return
  }
  output({ id, error: { code: 'method_not_found', message: method } })
})
input.on('close', () => { for (const s of sessions.values()) clearInterval(s.timer) })
