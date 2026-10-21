export type SessionStatus = 'idle' | 'running' | 'stopping' | 'failed' | 'cancelled'

export interface SessionSummary {
  id: string
  title: string
  workspace: string
  model: string
  updated_at: string
  status: SessionStatus
}

export interface TranscriptMessage {
  id: string
  role: 'user' | 'assistant' | 'tool' | 'system'
  content: string
  turn_id?: string
  agent_id?: string
  tool_name?: string
  call_id?: string
  status?: string
  arguments?: Record<string, unknown>
}

export interface Approval {
  approval_id: string
  tool_name: string
  arguments: Record<string, unknown>
  turn_id?: string
  agent_id?: string
}

export interface PraxisEvent {
  event: string
  session_id?: string
  turn_id?: string
  agent_id?: string
  sequence?: number
  data: Record<string, unknown>
}

export interface SessionSnapshot {
  session: SessionSummary
  messages: TranscriptMessage[]
  approvals: Approval[]
  sequence: number
}

export interface ConnectionStatus {
  state: 'connecting' | 'connected' | 'disconnected' | 'error'
  message?: string
}

export interface DesktopSettings {
  praxisPath: string
  pythonPath: string
  workspace: string
  model: string
  baseUrl: string
  apiKeyConfigured: boolean
}

export interface DesktopInfo {
  settings: DesktopSettings
  connection: ConnectionStatus
  version: string
  platform: string
}

export interface DesktopAPI {
  getInfo(): Promise<DesktopInfo>
  request<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T>
  onEvent(listener: (event: PraxisEvent) => void): () => void
  onConnection(listener: (status: ConnectionStatus) => void): () => void
  updateSettings(settings: Partial<Omit<DesktopSettings, 'apiKeyConfigured'>> & { apiKey?: string }): Promise<DesktopInfo>
  chooseDirectory(kind: 'workspace' | 'praxis'): Promise<string | null>
  choosePython(): Promise<string | null>
  openExternal(url: string): Promise<void>
  openWorkspace(): Promise<void>
  restart(): Promise<void>
  windowAction(action: 'minimize' | 'maximize' | 'close'): void
}

declare global {
  interface Window { praxis: DesktopAPI }
}
