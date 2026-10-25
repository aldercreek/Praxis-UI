import { useCallback, useEffect, useRef, useState } from 'react'
import { CircleAlert, CircleDashed, CircleSlash, Clock3, LoaderCircle, Plug, RefreshCw, X } from 'lucide-react'
import type { McpServerStatus, McpStatus } from '../../shared/protocol'
import { errorMessage } from './usePraxis'
import './mcpStatus.css'

const labels: Record<McpServerStatus['state'], string> = {
  disabled: '已禁用', queued: '等待连接', connecting: '连接中', retrying: '等待重试',
  connected: '已连接', failed: '连接失败', disconnected: '已断开'
}

function StatusIcon({ state }: { state: McpServerStatus['state'] }) {
  if (state === 'connecting') return <LoaderCircle className="mcp-spin" size={13} aria-hidden="true" />
  if (state === 'retrying') return <Clock3 size={13} aria-hidden="true" />
  if (state === 'queued') return <CircleDashed size={13} aria-hidden="true" />
  if (state === 'disabled') return <CircleSlash size={13} aria-hidden="true" />
  if (state === 'failed' || state === 'disconnected') return <CircleAlert size={13} aria-hidden="true" />
  return <i className="mcp-status-dot" aria-hidden="true" />
}

export function McpStatusDialog({ close }: { close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const generation = useRef(0)
  const [servers, setServers] = useState<McpServerStatus[]>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const refresh = useCallback(async () => {
    const request = ++generation.current
    setLoading(true)
    setError('')
    try {
      const result = await window.praxis.request<McpStatus>('mcp.status')
      if (request === generation.current) setServers(result.servers)
    } catch (error) {
      if (request === generation.current) setError(errorMessage(error))
    } finally {
      if (request === generation.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    dialog.current?.showModal()
    void refresh()
    return () => { generation.current++ }
  }, [refresh])

  return <dialog ref={dialog} className="mcp-dialog" aria-labelledby="mcp-title" onCancel={close} onClose={close}>
    <header className="mcp-header">
      <h2 id="mcp-title"><Plug size={16} aria-hidden="true" />MCP 服务</h2>
      <div className="mcp-actions">
        <button type="button" className="icon-button" aria-label="刷新" title="刷新" disabled={loading} onClick={() => void refresh()}><RefreshCw className={loading ? 'mcp-spin' : undefined} size={15} /></button>
        <button type="button" className="icon-button" aria-label="关闭" title="关闭 (Esc)" autoFocus onClick={close}><X size={16} /></button>
      </div>
    </header>
    <div className="mcp-status-content" aria-busy={loading}>
      {error && <p role="alert">{error}</p>}
      {!servers && loading && <div role="status" className="mcp-loading"><span className="visually-hidden">正在查询…</span><i /><i /><i /></div>}
      {servers?.length === 0 && <p>未配置 MCP 服务</p>}
      {servers && servers.length > 0 && <ul aria-label="MCP 服务状态">{servers.map(server => <li key={server.name}>
        <span className="mcp-name" title={server.name}>{server.name}</span><span className={`mcp-state mcp-state-${server.state}`}><StatusIcon state={server.state} />{labels[server.state] || server.state}</span>
      </li>)}</ul>}
    </div>
  </dialog>
}
