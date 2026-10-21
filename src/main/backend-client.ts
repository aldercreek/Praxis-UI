import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { StringDecoder } from 'node:string_decoder'
import type { ConnectionStatus, PraxisEvent } from '../shared/protocol'

export interface BackendLaunch {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class BackendClient extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams
  private pending = new Map<string, PendingRequest>()
  private counter = 0
  private generation = 0
  private stopping = false
  private outbound: string[] = []
  private backpressured = false
  private activeSessions = new Set<string>()
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
    this.stopping = false
    const generation = ++this.generation
    this.setStatus({ state: 'connecting', message: 'Connecting to Praxis…' })
    let text = ''
    let failureReason: string | undefined
    const decoder = new StringDecoder('utf8')
    const child = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    this.child = child
    const failed = (message: string): void => {
      if (generation !== this.generation) return
      failureReason ??= message
      this.rejectPending(new Error(failureReason))
      this.activeSessions.clear()
      if (!this.stopping) this.setStatus({ state: 'error', message: failureReason })
    }
    child.on('error', error => failed(`Unable to start Praxis: ${error.message}`))
    child.on('exit', (code, signal) => {
      failed(`Praxis exited (${signal ?? code ?? 'unknown reason'}). Reconnect in Settings.`)
      if (this.child === child) this.child = undefined
    })
    child.stdin.on('error', error => failed(`Praxis communication interrupted: ${error.message}`))
    child.stdin.on('drain', () => {
      if (this.child !== child) return
      this.backpressured = false
      this.flush()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      let message = chunk.toString('utf8')
      const key = launch.env.ADA_API_KEY
      if (key) message = message.split(key).join('[redacted]')
      this.emit('diagnostic', message.slice(0, 8192))
    })
    child.stdout.on('data', (chunk: Buffer) => {
      if (generation !== this.generation) return
      text += decoder.write(chunk)
      let newline = text.indexOf('\n')
      while (newline >= 0) {
        const line = text.slice(0, newline).trim()
        text = text.slice(newline + 1)
        if (line) {
          try { this.receive(JSON.parse(line)) }
          catch {
            failed('Praxis returned an invalid message. Check the backend version or reconnect.')
            child.kill()
            return
          }
        }
        newline = text.indexOf('\n')
      }
      if (text.length > 16 * 1024 * 1024) {
        failed('The Praxis message exceeded the size limit. The connection was closed.')
        child.kill()
      }
    })
    try {
      const info = await this.request<{ protocol_version: number; model: string; configured: boolean }>('initialize')
      if (generation !== this.generation) return
      if (info.protocol_version !== 1) throw new Error('Incompatible Praxis protocol version. Update the backend.')
      this.model = info.model
      this.configured = info.configured
      this.setStatus({ state: 'connected' })
    } catch (error) {
      failed(error instanceof Error ? error.message : String(error))
      if (this.child === child) child.kill()
      throw error
    }
  }

  request<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, timeoutMs = 180_000): Promise<T> {
    if (!this.child || this.child.exitCode !== null || this.child.stdin.destroyed) {
      return Promise.reject(new Error('Praxis is not connected. Check the backend in Settings.'))
    }
    if (this.pending.size >= 256) return Promise.reject(new Error('Too many pending requests. Try again later.'))
    const id = `${this.generation}:${++this.counter}`
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Praxis request timed out: ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer })
      this.outbound.push(JSON.stringify({ id, method, params }) + '\n')
      this.flush()
    })
  }

  private flush(): void {
    const stream = this.child?.stdin
    if (!stream || stream.destroyed || this.backpressured) return
    while (this.outbound.length) {
      if (!stream.write(this.outbound.shift()!)) { this.backpressured = true; return }
    }
  }

  private receive(frame: unknown): void {
    if (!frame || typeof frame !== 'object') throw new Error('Invalid frame')
    const message = frame as Record<string, unknown>
    if (typeof message.id === 'string') {
      const pending = this.pending.get(message.id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(message.id)
      if (message.error) {
        const error = message.error as { message?: string; code?: string }
        pending.reject(new Error(error.message ?? 'Praxis request failed'))
      } else pending.resolve(message.result)
      return
    }
    if (typeof message.event !== 'string' || !message.data || typeof message.data !== 'object') {
      throw new Error('Invalid event')
    }
    const event = message as unknown as PraxisEvent
    if (event.session_id) {
      if (event.event === 'TurnStarted') this.activeSessions.add(event.session_id)
      if (event.event === 'SessionUpdated') {
        const session = event.data.session as { status?: string } | undefined
        if (session?.status === 'running' || session?.status === 'stopping') this.activeSessions.add(event.session_id)
      }
      if (event.event === 'TurnSettled') this.activeSessions.delete(event.session_id)
    }
    this.emit('event', event)
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
    this.outbound = []
    this.backpressured = false
  }

  async stop(): Promise<void> {
    const child = this.child
    if (!child) return
    this.stopping = true
    const exited = new Promise<void>(resolve => {
      if (child.exitCode !== null) resolve()
      else child.once('exit', () => resolve())
    })
    try { await this.request('shutdown', {}, 3000) } catch { /* EOF also requests cleanup. */ }
    child.stdin.end()
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([exited, new Promise<void>(resolve => { timer = setTimeout(resolve, 4000) })])
    if (timer) clearTimeout(timer)
    if (child.exitCode === null) {
      if (process.platform === 'win32' && child.pid) {
        await new Promise<void>(resolve => {
          const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
          killer.once('error', () => { child.kill(); resolve() })
          killer.once('exit', () => resolve())
        })
      } else child.kill('SIGKILL')
    }
    if (this.child === child) this.child = undefined
    this.rejectPending(new Error('Praxis connection closed'))
    this.activeSessions.clear()
    this.setStatus({ state: 'disconnected' })
  }
}
