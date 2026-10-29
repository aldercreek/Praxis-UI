export type SessionStatus = 'idle' | 'running' | 'stopping' | 'failed' | 'cancelled'

export interface McpServerStatus {
  name: string
  state: 'disabled' | 'queued' | 'connecting' | 'retrying' | 'connected' | 'failed' | 'disconnected'
}

export interface McpStatus { servers: McpServerStatus[] }

export interface SessionSummary {
  id: string
  title: string
  workspace: string
  model: string
  updated_at: string
  /** Derived display status; never persisted as a session state machine. */
  status: SessionStatus
  active_turn?: { id: string; cancel_requested: boolean } | null
  latest_turn?: { id: string; status: "running" | "completed" | "cancelled" | "failed"; error?: string } | null
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
  structured_output?: Record<string, unknown>
  source?: 'user' | 'agent'
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
  pending_inputs?: { command_id: string; content: string }[]
  sending_input_id?: string | null
  view_events?: PraxisEvent[]
}

export interface ConnectionStatus {
  state: 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'error'
  message?: string
}

export interface DesktopSettings {
  praxisPath: string
  pythonPath: string
  workspace: string
  model: string
  baseUrl: string
  bypassApprovals: boolean
  apiKeyConfigured: boolean
}

export interface DesktopInfo {
  settings: DesktopSettings
  connection: ConnectionStatus
  version: string
  platform: string
}

export interface FileReference {
  path: string
  workspace: string
}

export interface FilePreview {
  path: string
  name: string
  kind: 'text' | 'markdown' | 'image' | 'pdf' | 'unsupported'
  size: number
  canOpen: boolean
  text?: string
  dataUrl?: string
  truncated?: boolean
  notice?: string
}

export interface FileActionResult {
  path: string
  action: 'open' | 'reveal'
  simulated: boolean
}

export interface DesktopAPI {
  acknowledge(sessionId: string, sequence: number): void
  getInfo(): Promise<DesktopInfo>
  request<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T>
  onEvent(listener: (event: PraxisEvent) => void): () => void
  onConnection(listener: (status: ConnectionStatus) => void): () => void
  updateSettings(settings: Partial<Omit<DesktopSettings, 'apiKeyConfigured'>> & { apiKey?: string }): Promise<DesktopInfo>
  chooseDirectory(kind: 'workspace' | 'praxis'): Promise<string | null>
  choosePython(): Promise<string | null>
  openExternal(url: string): Promise<void>
  openWorkspace(): Promise<void>
  previewFile(reference: FileReference): Promise<FilePreview>
  openFile(reference: FileReference): Promise<FileActionResult>
  revealFile(reference: FileReference): Promise<FileActionResult>
  restart(): Promise<void>
  windowAction(action: 'minimize' | 'maximize' | 'close'): void
}

declare global {
  interface Window { praxis: DesktopAPI }
}
