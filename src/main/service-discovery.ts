import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

export interface ServiceEndpoint { url: string; token: string; instance_id: string }
export interface BackendLaunch {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  dataDir?: string
  endpoint?: ServiceEndpoint
}

export async function discoverService(launch: BackendLaunch): Promise<ServiceEndpoint> {
  if (launch.endpoint) { await validate(launch.endpoint); return launch.endpoint }
  const directory = launch.dataDir || launch.env.PRAXIS_DATA_DIR || join(homedir(), '.praxis')
  async function read(): Promise<ServiceEndpoint> {
    const record = JSON.parse(await readFile(join(directory, 'service.json'), 'utf8'))
    if (!Number.isInteger(record.port) || record.port <= 0 || record.port > 65535) throw new Error('Invalid service port')
    const endpoint = { url: `http://127.0.0.1:${record.port}`, instance_id: record.instance_id,
      token: (await readFile(join(directory, 'service.token'), 'utf8')).trim() }
    await validate(endpoint)
    return endpoint
  }
  try { return await read() } catch (error) { if (error instanceof ProtocolError) throw error }
  // This short-lived launcher arranges independent process ownership. It is not
  // the service process, and Electron never sends a shutdown command on exit.
  await promisify(execFile)(launch.command, [...launch.args, '--ensure', '--data-dir', directory], {
    cwd: launch.cwd, env: launch.env, windowsHide: true, timeout: 25_000, maxBuffer: 256_000
  })
  return read()
}

async function validate(endpoint: ServiceEndpoint): Promise<void> {
  const url = new URL(endpoint.url)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('Expected a local Praxis service')
  const response = await fetch(endpoint.url + '/api/health', {
    headers: { Authorization: `Bearer ${endpoint.token}` }, signal: AbortSignal.timeout(1500)
  })
  if (!response.ok) throw new Error('Service authentication failed')
  const health = await response.json() as Record<string, unknown>
  if (health.service !== 'praxis' || health.instance_id !== endpoint.instance_id) throw new Error('Service identity mismatch')
  if (health.protocol_version !== 1) throw new ProtocolError('Incompatible Praxis protocol; update backend and clients together')
  if (!health.ready) throw new Error('Praxis is not ready')
}

class ProtocolError extends Error {}
