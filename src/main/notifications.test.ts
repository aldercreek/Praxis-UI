import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { DesktopNotifications, notificationPayload } from './notifications'

const payload = { key: 'chat:turn:completed', sessionId: 'chat', kind: 'completed', title: 'Review files', body: 'Task completed' }
function harness() {
  const window = { isFocused: vi.fn(() => false), isMinimized: vi.fn(() => true), isDestroyed: vi.fn(() => false), restore: vi.fn(), show: vi.fn(), focus: vi.fn(), flashFrame: vi.fn(), webContents: { send: vi.fn() } }
  const notification = Object.assign(new EventEmitter(), { show: vi.fn(), close: vi.fn() })
  const options = { enabled: vi.fn(() => true), supported: vi.fn(() => true), window: () => window, create: vi.fn(() => notification), icon: 'icon.png' }
  return { window, notification, options, manager: new DesktopNotifications(options) }
}

describe('native desktop notifications', () => {
  it('validates fields and caps native title and body lengths', () => {
    for (const invalid of [null, [], 'text', { ...payload, key: '' }, { ...payload, sessionId: 3 }, { ...payload, title: {} }, { ...payload, body: false }, { ...payload, kind: 'cancelled' }]) expect(notificationPayload(invalid)).toBeUndefined()
    expect(notificationPayload({ ...payload, title: 'x'.repeat(90), body: 'y'.repeat(200) })).toMatchObject({ title: 'x'.repeat(80), body: 'y'.repeat(160) })
  })

  it('suppresses notifications when disabled, focused or unsupported', () => {
    for (const condition of ['enabled', 'focused', 'supported', 'destroyed']) {
      const { manager, options, window } = harness()
      if (condition === 'enabled') options.enabled.mockReturnValue(false)
      if (condition === 'supported') options.supported.mockReturnValue(false)
      if (condition === 'focused') window.isFocused.mockReturnValue(true)
      if (condition === 'destroyed') window.isDestroyed.mockReturnValue(true)
      manager.send(payload)
      expect(options.create).not.toHaveBeenCalled()
      expect(window.flashFrame).not.toHaveBeenCalled()
    }
  })

  it('retains notifications and restores the requested session when clicked', () => {
    const { manager, options, window, notification } = harness()
    manager.send(payload)
    manager.send(payload)
    expect(options.create).toHaveBeenCalledExactlyOnceWith({ title: payload.title, body: payload.body, silent: false, icon: 'icon.png' })
    expect(notification.show).toHaveBeenCalledOnce()
    expect(window.flashFrame).toHaveBeenCalledWith(true)
    expect(manager.active.size).toBe(1)
    notification.emit('click')
    expect(manager.active.size).toBe(0)
    expect(window.restore).toHaveBeenCalledOnce()
    expect(window.show).toHaveBeenCalledOnce()
    expect(window.focus).toHaveBeenCalledOnce()
    expect(window.webContents.send).toHaveBeenCalledWith('praxis:open-session', 'chat')
  })

  it('cleans up closed or failed notifications and clears them when disabled', () => {
    const { manager, notification, window } = harness()
    manager.send(payload)
    notification.emit('close')
    expect(manager.active.size).toBe(0)
    manager.send(payload)
    notification.emit('failed')
    expect(manager.active.size).toBe(0)
    manager.send(payload)
    manager.clear()
    expect(notification.close).toHaveBeenCalledOnce()
    expect(manager.active.size).toBe(0)
    expect(window.flashFrame).toHaveBeenLastCalledWith(false)
  })
})
