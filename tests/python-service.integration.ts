import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { BackendClient } from '../src/main/backend-client'
import type { PraxisEvent, SessionSnapshot, SessionSummary } from '../src/shared/protocol'

let directory: string
let processHandle: ChildProcess | undefined
let servicePid: number | undefined
const clients: BackendClient[] = []

afterEach(async () => {
  for (const client of clients.splice(0)) await client.stop()
  if (servicePid) {
    // Windows venv launchers may delegate to a different Python PID. This PID
    // comes exclusively from the registration in our fresh temporary directory.
    try { process.kill(servicePid) } catch { /* Already exited. */ }
  }
  if (processHandle && processHandle.exitCode === null && processHandle.signalCode === null) {
    const exited = once(processHandle, 'exit')
    processHandle.kill()
    await exited
  }
  if (directory) await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

it('shares a real Python session, deduplicates input and resumes retained work across desktop clients', async () => {
  directory = await mkdtemp(join(tmpdir(), 'praxis-python-integration-'))
  const repository = resolve(process.env.PRAXIS_PATH || '../Praxis')
  const python = process.env.PRAXIS_PYTHON || join(repository, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  const env = { ...process.env, PYTHONPATH: join(repository, 'src'), ADA_API_KEY: 'offline-test', ADA_MODEL: 'offline', PRAXIS_BYPASS_APPROVALS: '0' }
  processHandle = spawn(python, [resolve('tests/fixtures/python-service.py'), '--data-dir', directory], { env, windowsHide: true, stdio: 'ignore' })
  let record: { pid: number }
  await expect.poll(async () => {
    try { record = JSON.parse(await readFile(join(directory, 'service.json'), 'utf8')); servicePid = record.pid; return record.pid > 0 }
    catch { return undefined }
  }, { timeout: 15_000 }).toBe(true)

  async function connect() {
    const client = new BackendClient()
    clients.push(client)
    await client.start({ command: python, args: ['-m', 'praxis_agent.service'], cwd: repository, env, dataDir: directory })
    return client
  }
  const first = await connect()
  const { session } = await first.request<{ session: SessionSummary }>('session.create', { workspace: directory })
  const events: PraxisEvent[] = []
  first.on('event', (event: PraxisEvent) => { events.push(event); first.acknowledge(session.id, event.sequence!) })
  await first.request('input.submit', { session_id: session.id, text: 'hold this turn' })
  await expect.poll(() => events.some(event => event.event === 'ModelRequestStarted')).toBe(true)

  const second = await connect()
  const snapshot = await second.request<SessionSnapshot>('session.open', { session_id: session.id })
  second.acknowledge(session.id, snapshot.sequence)
  expect(snapshot.session.status).toBe('running')
  expect(snapshot.messages.filter(message => message.role === 'user')).toHaveLength(1)
  await expect(second.request('settings.update', { bypass_approvals: true })).rejects.toThrow('Stop running sessions')

  const input = { session_id: session.id, command_id: 'same-submission', text: 'continue after cancellation' }
  const results = await Promise.all([first.request('input.submit', input), second.request('input.submit', input)])
  expect(results[0]).toEqual(results[1])
  await first.stop()
  const stillRunning = await second.request<SessionSnapshot>('session.open', { session_id: session.id })
  expect(stillRunning.session.active_turn?.id).toBe(snapshot.session.active_turn?.id)
  await second.request('turn.cancel', { session_id: session.id, turn_id: snapshot.session.active_turn!.id })
  await expect.poll(async () => (await second.request<SessionSnapshot>('session.open', { session_id: session.id })).session.active_turn).toBeNull()
  const cancelled = await second.request<SessionSnapshot>('session.open', { session_id: session.id })
  expect(cancelled.session.latest_turn?.status).toBe('cancelled')
  expect(cancelled.pending_inputs).toEqual([{ command_id: input.command_id, content: input.text }])

  await second.request('input.resume', { session_id: session.id })
  await expect.poll(async () => (await second.request<SessionSnapshot>('session.open', { session_id: session.id })).session.latest_turn?.status).toBe('completed')
  const finished = await second.request<SessionSnapshot>('session.open', { session_id: session.id })
  expect(finished.messages.filter(message => message.role === 'user').map(message => message.content)).toEqual(['hold this turn', input.text])
  expect(finished.pending_inputs).toEqual([])
  expect(finished.messages.some(message => message.content === 'offline response')).toBe(true)
})
