import type { PraxisEvent } from '../shared/protocol'
import type { ServiceEndpoint } from './service-discovery'

export class EventSubscription {
  private applied = 0
  private closed = false
  private controller?: AbortController
  private resolveReady!: () => void
  private rejectReady!: (error: Error) => void
  readonly ready: Promise<void>

  constructor(private sessionId: string, private endpoint: () => ServiceEndpoint,
    private rediscover: () => Promise<ServiceEndpoint>, private onEvent: (event: PraxisEvent) => void,
    private onError: (message: string) => void, private onConnection: (connected: boolean) => void = () => {}) {
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject })
    void this.listen()
  }

  acknowledge(sequence: number): void {
    if (Number.isSafeInteger(sequence)) this.applied = Math.max(this.applied, sequence)
  }

  private async listen(): Promise<void> {
    let failures = 0
    while (!this.closed) {
      let heartbeatTimer: ReturnType<typeof setTimeout> | undefined
      const controller = new AbortController()
      this.controller = controller
      const alive = () => {
        clearTimeout(heartbeatTimer)
        heartbeatTimer = setTimeout(() => controller.abort(), 45_000)
      }
      try {
        alive()
        const endpoint = this.endpoint()
        const response = await fetch(`${endpoint.url}/api/sessions/${encodeURIComponent(this.sessionId)}/events?after=${this.applied}`, {
          headers: { Authorization: `Bearer ${endpoint.token}` }, signal: controller.signal
        })
        if (response.status === 404 || response.status === 410) { this.deleted(); return }
        if (!response.ok || !response.body) throw new Error(`Event subscription failed: HTTP ${response.status}`)
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) throw new Error('Event stream ended')
            if (this.closed || this.controller !== controller) return
            alive()
            failures = 0
            buffer += decoder.decode(value, { stream: true })
            buffer = buffer.replace(/\r\n/g, '\n')
            let boundary: number
            while ((boundary = buffer.indexOf('\n\n')) >= 0) {
              const block = buffer.slice(0, boundary)
              buffer = buffer.slice(boundary + 2)
              const lines = block.split('\n')
              const kind = lines.find(line => line.startsWith('event:'))?.slice(6).trim()
              if (kind === 'deleted') { this.deleted(); return }
              if (kind === 'ready') { this.onConnection(true); this.resolveReady(); continue }
              const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
              if (!data) continue
              const event = JSON.parse(data) as PraxisEvent
              if (event.session_id !== this.sessionId || !Number.isSafeInteger(event.sequence)) throw new Error('Invalid session event')
              if (event.sequence! > this.applied) this.onEvent(event)
            }
          }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
      } catch (error) {
        if (this.closed) return
        this.onConnection(false)
        this.onError(String(error))
        if (failures >= 3) {
          try { await this.rediscover() } catch (failure) { this.onError(String(failure)); this.rejectReady(new Error(String(failure))) }
          failures = 0
        }
        await new Promise(resolve => setTimeout(resolve, Math.min(500 * 2 ** failures++, 2000)))
      } finally { clearTimeout(heartbeatTimer) }
    }
  }

  close(): void {
    this.closed = true
    this.controller?.abort()
    this.resolveReady()
  }

  private deleted(): void {
    this.closed = true
    this.rejectReady(new Error('This chat has been deleted.'))
    this.onEvent({ event: 'SessionDeleted', session_id: this.sessionId, data: {} })
  }
}
