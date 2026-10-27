import { describe, expect, it, vi } from 'vitest'
import type { Approval } from '../../shared/protocol'
import { presentApproval, submitApprovalDecision } from './approvalPresentation'

const request = (patch: Partial<Approval> = {}): Approval => ({ approval_id: 'approval-1', turn_id: 'turn-1', agent_id: 'main', tool_name: 'run_command', arguments: { command: 'echo hello' }, ...patch })

describe('approval details', () => {
  it('preserves the actual multiline command and keeps extra parameters inspectable', () => {
    const command = 'Get-ChildItem\nWrite-Output "hello"'
    const view = presentApproval(request({ arguments: { command, cwd: 'D:/project' } }))
    expect(view.detail).toBe(command)
    expect(view.detailLabel).toBe('Command')
    expect(JSON.parse(view.parameters!)).toEqual({ command, cwd: 'D:/project' })
  })

  it('shows real tool parameters instead of inventing a shell command for another tool', () => {
    const view = presentApproval(request({ tool_name: 'edit_file', agent_id: 'worker-2', arguments: { path: 'README.md', replacement: 'hello' } }))
    expect(view).toMatchObject({ tool: 'edit_file', agent: 'worker-2', detailLabel: 'Arguments' })
    expect(JSON.parse(view.detail)).toEqual({ path: 'README.md', replacement: 'hello' })
  })
})

describe('shared approval submission guard', () => {
  it('sends only one boolean decision when approval options are activated repeatedly', async () => {
    let finish!: () => void
    const submit = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
    const pending = new Set<string>()
    const changed = vi.fn()
    const first = submitApprovalDecision(pending, 'approval-1', true, submit, changed)
    await submitApprovalDecision(pending, 'approval-1', false, submit, changed)
    expect(submit).toHaveBeenCalledExactlyOnceWith('approval-1', true)
    expect(changed).toHaveBeenCalledTimes(1)
    finish(); await first
    await submitApprovalDecision(pending, 'approval-1', false, submit, changed)
    expect(submit).toHaveBeenCalledTimes(1)
    expect(pending.has('approval-1')).toBe(true)
  })

  it('propagates a failed request and releases only that approval for retry', async () => {
    const pending = new Set<string>(['other-approval'])
    const error = new Error('Disconnected')
    const submit = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce(undefined)
    const changed = vi.fn()
    await expect(submitApprovalDecision(pending, 'approval-1', false, submit, changed)).rejects.toBe(error)
    expect(pending).toEqual(new Set(['other-approval']))
    await submitApprovalDecision(pending, 'approval-1', false, submit, changed)
    expect(submit).toHaveBeenNthCalledWith(2, 'approval-1', false)
    expect(pending).toEqual(new Set(['other-approval', 'approval-1']))
  })
})
