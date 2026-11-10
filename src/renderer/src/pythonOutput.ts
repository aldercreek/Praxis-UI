import type { DisplayMessage } from './state'

/** Both live events and restored history may carry the result as JSON text. */
export function pythonResult(message: DisplayMessage): Record<string, unknown> | undefined {
  if (message.tool_name !== 'run_code') return undefined
  for (const value of [message.structured_output, message.content, message.output]) {
    let parsed: unknown = value
    if (typeof value === 'string') {
      try { parsed = JSON.parse(value) } catch { continue }
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      && ['result', 'stdout', 'stderr', 'error', 'error_kind', 'output_files'].some(key => Object.hasOwn(parsed, key))) {
      return parsed as Record<string, unknown>
    }
  }
  return undefined
}
