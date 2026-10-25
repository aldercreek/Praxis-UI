import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type { ConnectionStatus, PraxisEvent, SessionSnapshot, SessionSummary } from '../shared/protocol'
import { discoverService, type BackendLaunch, type ServiceEndpoint } from './service-discovery'
import { EventSubscription } from './event-subscription'
export type { BackendLaunch } from './service-discovery'

export class BackendClient extends EventEmitter {
  private endpoint?: ServiceEndpoint
  private launch?: BackendLaunch
  private subscriptions = new Map<string, EventSubscription>()
  private discovery?: Promise<ServiceEndpoint>
  private generation = 0
  private activeSessions = new Set<string>()
  private disconnectedStreams = new Set<string>()
  status: ConnectionStatus = { state: 'disconnected' }
  model = ''
  configured = false

  get busy(): boolean { return this.activeSessions.size > 0 }

  private setStatus(status: ConnectionStatus): void {
    this.status = status
    this.emit('connection', status)
  }

  async start(launch: BackendLaunch): Promise<void> {
    await this.stop()
    this.launch = launch
    this.setStatus({ state: 'connecting', message: 'Connecting to Praxis…' })
    try {
      this.endpoint = await this.discover()
      const info = await this.http<{ model: string; configured: boolean }>('GET', '/api/health')
      this.model = info.model
      this.configured = info.configured
      this.setStatus({ state: 'connected' })
    } catch (error) {
      this.setStatus({ state: 'error', message: String(error) })
      throw error
    }
  }

  private discover(): Promise<ServiceEndpoint> {
    if (!this.discovery) {
      this.discovery = discoverService(this.launch!).finally(() => { this.discovery = undefined })
    }
    return this.discovery
  }

  private async reconnect(): Promise<ServiceEndpoint> {
    const endpoint = await this.discover()
    this.endpoint = endpoint
    return endpoint
  }

  private async http<T = Record<string, unknown>>(method: string, path: string, data?: unknown): Promise<T> {
    if (!this.endpoint) throw new Error('Praxis is not connected')
    const generation = this.generation
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await fetch(this.endpoint.url + path, {
          method, headers: { Authorization: `Bearer ${this.endpoint.token}`, 'Content-Type': 'application/json' },
          body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(30_000)
        })
        if (!response.ok) {
          if (response.status === 401 && attempt < 3) { await this.reconnect(); continue }
          const body = await response.json() as { error?: { message: string } }
          throw new RequestError(body.error?.message || `HTTP ${response.status}`)
        }
        return await response.json() as T
      } catch (error) {
        if (error instanceof RequestError || attempt >= 3 || generation !== this.generation) throw error
        await new Promise(resolve => setTimeout(resolve, 500 * 2 ** Math.min(attempt, 2)))
        if (attempt === 2) await this.reconnect()
      }
    }
  }

  private async subscribe(sessionId: string): Promise<void> {
    const existing = this.subscriptions.get(sessionId)
    if (existing) return existing.ready
    const generation = this.generation
    const subscription = new EventSubscription(
      sessionId, () => this.endpoint!, () => this.reconnect(),
      event => {
        if (generation !== this.generation) return
        if (event.event === 'SessionUpdated') {
          const summary = event.data.session as SessionSummary
          event.data.session = displaySession(summary)
          if (summary.active_turn) this.activeSessions.add(sessionId)
          else this.activeSessions.delete(sessionId)
        }
        this.emit('event', event)
      },
      message => this.emit('diagnostic', message),
      connected => {
        if (generation !== this.generation) return
        if (connected) this.disconnectedStreams.delete(sessionId)
        else this.disconnectedStreams.add(sessionId)
        const state = this.disconnectedStreams.size ? 'reconnecting' : 'connected'
        if (this.status.state !== state) this.setStatus({ state,
          message: state === 'reconnecting' ? 'Reconnecting to Praxis… Your work remains on the service.' : undefined })
      }
    )
    this.subscriptions.set(sessionId, subscription)
    await subscription.ready
  }

  acknowledge(sessionId: string, sequence: number): void {
    this.subscriptions.get(sessionId)?.acknowledge(sequence)
  }

  async request<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const sessionId = String(params.session_id || '')
    const session = `/api/sessions/${encodeURIComponent(sessionId)}`
    let result: unknown
    switch (method) {
      case 'initialize': result = await this.http('GET', '/api/health'); break
      case 'settings.update': result = await this.http('PUT', '/api/settings', params); break
      case 'session.list': {
        const listed = await this.http<{ sessions: SessionSummary[] }>('GET', '/api/sessions?' + new URLSearchParams(params as Record<string, string>))
        result = { sessions: listed.sessions.map(displaySession) }; break
      }
      case 'session.create': {
        const created = await this.http<{ session: SessionSummary }>('POST', '/api/sessions', { ...params, command_id: params.command_id || randomUUID() })
        await this.subscribe(created.session.id)
        result = { session: displaySession(created.session) }
        break
      }
      case 'session.open': {
        await this.subscribe(sessionId)
        const snapshot = await this.http<SessionSnapshot>('GET', session + '/snapshot')
        if (snapshot.session.active_turn) this.activeSessions.add(sessionId)
        else this.activeSessions.delete(sessionId)
        result = { ...snapshot, session: displaySession(snapshot.session) }
        break
      }
      case 'input.submit': result = await this.http('POST', session + '/inputs', { ...params, command_id: params.command_id || randomUUID() }); break
      case 'input.resume': result = await this.http('POST', session + '/inputs/resume', { command_id: params.command_id || randomUUID() }); break
      case 'input.delete': result = await this.http('DELETE', session + '/inputs/' + encodeURIComponent(String(params.command_id))); break
      case 'turn.cancel': result = await this.http('POST', session + '/turns/' + encodeURIComponent(String(params.turn_id)) + '/cancel'); break
      case 'approval.decide': result = await this.http('POST', '/api/approvals/' + encodeURIComponent(String(params.approval_id)) + '/decision', { approved: params.approved }); break
      default: throw new Error(`Unsupported operation: ${method}`)
    }
    return result as T
  }

  async stop(): Promise<void> {
    this.generation++
    for (const subscription of this.subscriptions.values()) subscription.close()
    this.subscriptions.clear()
    this.endpoint = undefined
    this.activeSessions.clear()
    this.disconnectedStreams.clear()
    this.setStatus({ state: 'disconnected' })
  }
}

class RequestError extends Error {}

function displaySession(session: SessionSummary): SessionSummary {
  const active = session.active_turn
  const latest = session.latest_turn?.status
  const status = active ? (active.cancel_requested ? 'stopping' : 'running')
    : latest === 'failed' || latest === 'cancelled' ? latest : 'idle'
  return { ...session, status }
}
