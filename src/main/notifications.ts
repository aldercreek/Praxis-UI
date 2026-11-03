import type { DesktopNotification } from '../shared/protocol'

interface NotificationWindow {
  isFocused(): boolean
  isMinimized(): boolean
  isDestroyed(): boolean
  restore(): void
  show(): void
  focus(): void
  flashFrame(value: boolean): void
  webContents: { send(channel: string, sessionId: string): void }
}

interface NativeNotification {
  on(event: 'click' | 'close' | 'failed', listener: () => void): unknown
  show(): void
  close(): void
}

export function notificationPayload(value: unknown): DesktopNotification | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const input = value as Record<string, unknown>
  if (!['key', 'sessionId', 'kind', 'title', 'body'].every(key => typeof input[key] === 'string')) return
  if (!['completed', 'failed', 'approval'].includes(input.kind as string)) return
  if (!input.key || !input.sessionId || (input.key as string).length > 1024 || (input.sessionId as string).length > 1024) return
  return { key: input.key as string, sessionId: input.sessionId as string, kind: input.kind as DesktopNotification['kind'], title: (input.title as string).slice(0, 80), body: (input.body as string).slice(0, 160) }
}

export class DesktopNotifications {
  readonly active = new Map<string, NativeNotification>()

  constructor(private options: {
    enabled: () => boolean
    supported: () => boolean
    window: () => NotificationWindow | undefined
    create: (options: { title: string; body: string; silent: boolean; icon: string }) => NativeNotification
    icon: string
  }) {}

  send(value: unknown): void {
    const payload = notificationPayload(value)
    const window = this.options.window()
    if (!payload || !window || window.isDestroyed() || !this.options.enabled() || window.isFocused() || !this.options.supported() || this.active.has(payload.key)) return
    const notification = this.options.create({ title: payload.title, body: payload.body, silent: false, icon: this.options.icon })
    const remove = () => { if (this.active.get(payload.key) === notification) this.active.delete(payload.key) }
    this.active.set(payload.key, notification)
    notification.on('click', () => {
      remove()
      const target = this.options.window()
      if (!target || target.isDestroyed()) return
      if (target.isMinimized()) target.restore()
      target.show()
      target.focus()
      target.webContents.send('praxis:open-session', payload.sessionId)
    })
    notification.on('close', remove)
    notification.on('failed', remove)
    try { notification.show(); window.flashFrame(true) } catch { remove() }
  }

  clear(): void {
    for (const notification of this.active.values()) notification.close()
    this.active.clear()
    const window = this.options.window()
    if (window && !window.isDestroyed()) window.flashFrame(false)
  }
}
