import type { Approval } from '../../shared/protocol'

const approvalAgent = (agentId?: string) => !agentId || agentId === 'main' || agentId === 'root' ? 'main' : agentId

export function presentApproval(approval: Approval) {
  const command = typeof approval.arguments.command === 'string' && approval.arguments.command.trim() ? approval.arguments.command : undefined
  return {
    tool: approval.tool_name,
    agent: approvalAgent(approval.agent_id) === 'main' ? undefined : approval.agent_id,
    detailLabel: command ? 'Command' : 'Arguments',
    preview: command?.split(/\r?\n/, 1)[0],
    detail: command || JSON.stringify(approval.arguments, null, 2),
    parameters: command && Object.keys(approval.arguments).some(key => key !== 'command') ? JSON.stringify(approval.arguments, null, 2) : undefined
  }
}

/** Keep successful submissions locked until the server removes the approval.
 * A ref-owned Set also prevents two controls submitting before React rerenders. */
export async function submitApprovalDecision(
  pending: Set<string>,
  id: string,
  approved: boolean,
  submit: (id: string, approved: boolean) => Promise<void>,
  changed: () => void
): Promise<void> {
  if (pending.has(id)) return
  pending.add(id)
  changed()
  try {
    await submit(id, approved)
  } catch (error) {
    pending.delete(id)
    changed()
    throw error
  }
}
