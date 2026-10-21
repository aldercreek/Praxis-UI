import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BackendClient, type BackendLaunch } from '../src/main/backend-client'
import type { ConnectionStatus, PraxisEvent } from '../src/shared/protocol'

const launch: BackendLaunch = {
  command: process.execPath,
  args: [resolve('tests/fixtures/rpc-fixture.cjs')],
  cwd: process.cwd(),
  env: { ...process.env }
}

const clients: BackendClient[] = []

async function connect(): Promise<BackendClient> {
  const client = new BackendClient()
  clients.push(client)
  await client.start(launch)
  return client
}

function event(name: string, sessionId: string, data: Record<string, unknown> = {}): PraxisEvent {
  return { event: name, session_id: sessionId, turn_id: `${sessionId}-turn`, data }
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.stop()))
})

describe('BackendClient with a real stdio child process', () => {
  it('negotiates the protocol before reporting a usable connection', async () => {
    const client = new BackendClient()
    clients.push(client)
    const states: string[] = []
    client.on('connection', (status: ConnectionStatus) => states.push(status.state))

    await client.start(launch)

    expect(states).toEqual(['connecting', 'connected'])
    expect(client.status.state).toBe('connected')
    expect(client.model).toBe('fixture-model')
    expect(client.configured).toBe(true)
    expect(client.busy).toBe(false)
  })

  it('matches simultaneous requests even when responses arrive in reverse order', async () => {
    const client = await connect()
    const completionOrder: string[] = []
    const slow = client.request('fixture.echo', { value: 'slow', delay: 80 })
      .then(result => { completionOrder.push('slow'); return result })
    const fast = client.request('fixture.echo', { value: 'fast', delay: 0 })
      .then(result => { completionOrder.push('fast'); return result })

    expect(await Promise.all([slow, fast])).toEqual([{ value: 'slow' }, { value: 'fast' }])
    expect(completionOrder).toEqual(['fast', 'slow'])
  })

  it('preserves Unicode when a response arrives one byte at a time', async () => {
    const client = await connect()
    const value = '你好，Praxis 👩‍💻 café\n第二行'

    await expect(client.request('fixture.chunked', { value })).resolves.toEqual({ value })
    expect(client.status.state).toBe('connected')
  })

  it('delivers interleaved session events with their routing identifiers intact', async () => {
    const client = await connect()
    const received: PraxisEvent[] = []
    client.on('event', (message: PraxisEvent) => received.push(message))
    const events = [
      { ...event('TextDelta', 'session-a', { text: '你好' }), sequence: 1 },
      { ...event('TextDelta', 'session-b', { text: 'Hello' }), sequence: 1 },
      { ...event('ToolCallStarted', 'session-a', { tool_name: 'read_file' }), sequence: 2, agent_id: 'child-a' }
    ]

    await client.request('fixture.events', { events })

    expect(received).toEqual(events)
    expect(received.filter(message => message.session_id === 'session-a')).toHaveLength(2)
  })

  it('stays busy until every active session has settled, including cancellation cleanup', async () => {
    const client = await connect()
    await client.request('fixture.events', {
      events: [event('TurnStarted', 'session-a'), event('TurnStarted', 'session-b')]
    })
    expect(client.busy).toBe(true)

    await client.request('fixture.events', { events: [event('TurnSettled', 'session-a')] })
    expect(client.busy).toBe(true)

    await client.request('fixture.events', { events: [event('TurnCancelled', 'session-b')] })
    expect(client.busy).toBe(true)

    await client.request('fixture.events', { events: [event('TurnSettled', 'session-b')] })
    expect(client.busy).toBe(false)
  })

  it('also recognizes a running session from its status update', async () => {
    const client = await connect()
    await client.request('fixture.events', {
      events: [event('SessionUpdated', 'session-a', { session: { status: 'running' } })]
    })
    expect(client.busy).toBe(true)

    await client.request('fixture.events', {
      events: [event('SessionUpdated', 'session-a', { session: { status: 'stopping' } })]
    })
    expect(client.busy).toBe(true)

    await client.request('fixture.events', { events: [event('TurnSettled', 'session-a')] })
    expect(client.busy).toBe(false)
  })

  it('rejects a command error without breaking other requests or the connection', async () => {
    const client = await connect()
    const failed = expect(client.request('fixture.error')).rejects.toThrow('此会话已有任务正在执行')
    const successful = client.request('fixture.echo', { value: 'still connected' })

    await failed
    await expect(successful).resolves.toEqual({ value: 'still connected' })
    expect(client.status.state).toBe('connected')
  })

  it('times out an unanswered command without poisoning subsequent responses', async () => {
    const client = await connect()
    await expect(client.request('fixture.never', {}, 30)).rejects.toThrow('Praxis request timed out: fixture.never')

    await expect(client.request('fixture.echo', { value: 'healthy' })).resolves.toEqual({ value: 'healthy' })
  })

  it('fails pending commands and surfaces malformed backend output', async () => {
    const client = await connect()
    const states: ConnectionStatus[] = []
    client.on('connection', (status: ConnectionStatus) => states.push(status))
    const pending = expect(client.request('fixture.never')).rejects.toThrow('invalid message')
    const trigger = expect(client.request('fixture.malformed')).rejects.toThrow('invalid message')

    await Promise.all([pending, trigger])

    expect(states.some(status => status.state === 'error' && status.message?.includes('invalid message'))).toBe(true)
  })

  it('rejects all pending requests and clears running state when the child crashes', async () => {
    const client = await connect()
    await client.request('fixture.events', { events: [event('TurnStarted', 'session-a')] })
    const waiting = expect(client.request('fixture.never')).rejects.toThrow('Praxis exited')
    const exiting = expect(client.request('fixture.exit')).rejects.toThrow('Praxis exited')

    await Promise.all([waiting, exiting])

    expect(client.status.state).toBe('error')
    expect(client.busy).toBe(false)
    await expect(client.request('fixture.echo')).rejects.toThrow('Praxis is not connected')
  })

  it('shuts down pending work and can start another independent backend connection', async () => {
    const client = await connect()
    await client.request('fixture.events', { events: [event('TurnStarted', 'session-a')] })
    const waiting = expect(client.request('fixture.never')).rejects.toThrow()

    await client.stop()
    await waiting
    expect(client.status.state).toBe('disconnected')
    expect(client.busy).toBe(false)

    await client.start(launch)
    await expect(client.request('fixture.echo', { value: 'restarted' })).resolves.toEqual({ value: 'restarted' })
    expect(client.status.state).toBe('connected')
  })

  it('refuses an incompatible backend protocol version', async () => {
    const client = new BackendClient()
    clients.push(client)

    await expect(client.start({
      ...launch,
      env: { ...launch.env, FIXTURE_PROTOCOL_VERSION: '2' }
    })).rejects.toThrow('Incompatible Praxis protocol version')
    expect(client.status.state).toBe('error')
  })
})
