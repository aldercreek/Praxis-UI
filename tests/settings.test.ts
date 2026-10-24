import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SettingsStore } from '../src/main/settings'
import type { DesktopSettings } from '../src/shared/protocol'

vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => false } }))

let directory: string
let file: string
const store = () => new SettingsStore(file, directory)
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'praxis-settings-')); file = join(directory, 'settings.json') })
afterEach(() => rmSync(directory, { recursive: true, force: true }))

describe('desktop approval preference', () => {
  it('defaults new and existing profiles without an approval preference to bypass', () => {
    expect(store().get().bypassApprovals).toBe(true)
    writeFileSync(file, JSON.stringify({ model: 'existing-model' }))
    expect(store().get()).toMatchObject({ model: 'existing-model', bypassApprovals: true })
  })

  it('preserves an explicit opt-out across reloads and unrelated updates', () => {
    store().update({ bypassApprovals: false })
    const reloaded = store()
    expect(reloaded.get().bypassApprovals).toBe(false)
    reloaded.update({ model: 'another-model' })
    expect(store().get().bypassApprovals).toBe(false)
    reloaded.update({ bypassApprovals: true })
    expect(store().get().bypassApprovals).toBe(true)
  })

  it('rejects malformed changes without changing the stored preference', () => {
    const settings = store()
    settings.update({ bypassApprovals: false })
    const before = readFileSync(file, 'utf8')
    expect(() => settings.update({ bypassApprovals: 'false' } as unknown as Partial<DesktopSettings>)).toThrow('Invalid approval mode')
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(settings.get().bypassApprovals).toBe(false)
  })
})
