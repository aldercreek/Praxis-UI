import { isBackgroundCommand, type DisplayMessage } from './state'

export function commandOutcome(message: DisplayMessage): { label: string; error: boolean } | undefined {
  if (isBackgroundCommand(message)) return { label: 'Running in background', error: false }
  const code = message.structured_output?.exit_code
  return typeof code === 'number' && Number.isFinite(code) ? { label: `Exit code ${code}`, error: code !== 0 } : undefined
}
