import { createServer, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { BackendClient } from '../src/main/backend-client'
import type { PraxisEvent } from '../src/shared/protocol'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0)) await close() })

async function fixture() {
  const journal: PraxisEvent[] = []
  const streams = new Set<ServerResponse>()
  const commands: Record<string, unknown>[] = []
  const afters: number[] = []
  let dropInputReply = false
  const summary = { id: 'S1', title: 'test', workspace: 'workspace', model: 'test', updated_at: new Date().toISOString(), active_turn: null }
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer token') { res.writeHead(401); res.end('{}'); return }
    const url = new URL(req.url!, 'http://localhost')
    if (url.pathname.endsWith('/events')) {
      const after = Number(url.searchParams.get('after'))
      afters.push(after)
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('event: ready\ndata: {}\n\n')
      for (const event of journal) if (event.sequence! > after) res.write(encode(event))
      streams.add(res)
      req.on('close', () => streams.delete(res))
      return
    }
    res.setHeader('Content-Type', 'application/json')
    if (url.pathname === '/api/mcp/servers') { res.end(JSON.stringify({ servers: [{ name: 'database', state: 'connected' }] })); return }
    if (url.pathname.endsWith('/health')) { res.end(JSON.stringify({ service: 'praxis', instance_id: 'instance', ready: true, protocol_version: 1, model: 'test', configured: true })); return }
    if (url.pathname.endsWith('/snapshot')) { res.end(JSON.stringify({ session: summary, sequence: journal.length, messages: [], approvals: [], pending_inputs: [] })); return }
    let raw = ''
    for await (const chunk of req) raw += chunk
    const data = raw ? JSON.parse(raw) : {}
    if (url.pathname.endsWith('/inputs')) {
      commands.push(data)
      if (dropInputReply) { dropInputReply = false; res.destroy(); return }
      res.end(JSON.stringify({ accepted: true, command_id: data.command_id })); return
    }
    if (url.pathname.endsWith('/sessions') && req.method === 'POST') { res.end(JSON.stringify({ session: summary })); return }
    if (url.pathname.endsWith('/sessions')) { res.end(JSON.stringify({ sessions: [summary] })); return }
    res.writeHead(409); res.end(JSON.stringify({ error: { message: 'conflict' } }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = (server.address() as { port: number }).port
  const clients: BackendClient[] = []
  cleanups.push(async () => {
    for (const client of clients) await client.stop()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
  return {
    commands, afters, streams,
    dropReply: () => { dropInputReply = true },
    async connect() {
      const client = new BackendClient()
      clients.push(client)
      await client.start({ command: '', args: [], cwd: '', env: {}, endpoint: { url: `http://127.0.0.1:${port}`, token: 'token', instance_id: 'instance' } })
      return client
    },
    append(data: Record<string, unknown>, name = 'TestEvent') {
      const event = { event: name, session_id: 'S1', sequence: journal.length + 1, data }
      journal.push(event)
      for (const stream of streams) stream.write(encode(event))
      return event
    }
  }
}
function encode(event: PraxisEvent) { return `id: ${event.sequence}\nevent: ${event.event}\ndata: ${JSON.stringify(event)}\n\n` }

describe('shared HTTP and SSE client', () => {
  it('validates identity, opens a subscription before reading a snapshot', async () => {
    const server = await fixture()
    const client = await server.connect()
    expect(client.configured).toBe(true)
    await client.request('session.open', { session_id: 'S1' })
    expect(server.afters).toEqual([0])
    expect(server.streams.size).toBe(1)
  })

  it('retries an ambiguous input response with the same command ID', async () => {
    const server = await fixture()
    const client = await server.connect()
    server.dropReply()
    await expect(client.request('input.submit', { session_id: 'S1', text: 'hello' })).resolves.toMatchObject({ accepted: true })
    expect(server.commands).toHaveLength(2)
    expect(server.commands[0].command_id).toBe(server.commands[1].command_id)
  })

  it('uses the last applied acknowledgement when a stream disconnects', async () => {
    const server = await fixture()
    const client = await server.connect()
    const events: PraxisEvent[] = []
    const states: string[] = []
    client.on('event', (event: PraxisEvent) => events.push(event))
    client.on('connection', status => states.push(status.state))
    await client.request('session.open', { session_id: 'S1' })
    server.append({ text: '中文' })
    await expect.poll(() => events.length).toBe(1)
    client.acknowledge('S1', 1)
    server.append({ text: 'not yet applied' })
    await expect.poll(() => events.length).toBe(2)
    for (const stream of server.streams) stream.destroy()
    server.append({ text: 'during disconnection' })
    await expect.poll(() => events.length).toBeGreaterThanOrEqual(4)
    expect(server.afters).toEqual([0, 1])
    expect(events.map(event => event.sequence)).toEqual([1, 2, 2, 3])
    expect(states).toEqual(['reconnecting', 'connected'])
  })

  it('disconnecting one client leaves the service and other clients available', async () => {
    const server = await fixture()
    const first = await server.connect()
    const second = await server.connect()
    await first.request('session.open', { session_id: 'S1' })
    await second.request('session.open', { session_id: 'S1' })
    await first.stop()
    await expect(second.request('initialize')).resolves.toMatchObject({ configured: true })
    expect(first.status.state).toBe('disconnected')
    expect(second.status.state).toBe('connected')
  })

  it('derives busy state from the service active turn', async () => {
    const server = await fixture()
    const client = await server.connect()
    await client.request('session.open', { session_id: 'S1' })
    server.append({ session: { id: 'S1', active_turn: { id: 'T1', cancel_requested: false } } }, 'SessionUpdated')
    await expect.poll(() => client.busy).toBe(true)
    server.append({ session: { id: 'S1', active_turn: null, latest_turn: { status: 'completed' } } }, 'SessionUpdated')
    await expect.poll(() => client.busy).toBe(false)
  })

  it('queries MCP status without opening a session or subscribing to events', async () => {
    const server = await fixture()
    const client = await server.connect()
    await expect(client.request('mcp.status')).resolves.toEqual({ servers: [{ name: 'database', state: 'connected' }] })
    expect(server.commands).toHaveLength(0)
    expect(server.streams.size).toBe(0)
  })
})
