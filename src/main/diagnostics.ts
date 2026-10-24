import type { Writable } from 'node:stream'

// A desktop app can outlive the launcher that owns its stderr pipe. Diagnostic
// output is best-effort and must never interrupt backend events or requests.
export function createDiagnosticWriter(stream: Writable): (message: string) => void {
  let available = true
  const disable = () => { available = false }
  stream.on('error', disable)

  return message => {
    if (!available || stream.destroyed || !stream.writable) return
    try {
      stream.write(message, error => { if (error) disable() })
    } catch {
      disable()
    }
  }
}
