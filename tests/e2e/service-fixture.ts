import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function stopFixtureService(directory: string): Promise<void> {
  try {
    const record = JSON.parse(await readFile(join(directory, 'service.json'), 'utf8'))
    const token = (await readFile(join(directory, 'service.token'), 'utf8')).trim()
    await fetch(`http://127.0.0.1:${record.port}/__shutdown`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3000) })
  } catch { /* Startup may have failed before creating a service. */ }
}
