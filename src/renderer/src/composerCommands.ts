export interface ComposerCommand { name: string; description: string; requiresSession?: boolean }

export const composerCommands: ComposerCommand[] = [
  { name: 'new', description: 'Start a new chat' },
  { name: 'settings', description: 'Open settings' },
  { name: 'mcp', description: 'Show MCP server status' },
  { name: 'delete', description: 'Delete this chat', requiresSession: true }
]

export function matchCommands(query: string, hasSession: boolean): ComposerCommand[] {
  return composerCommands.filter(command => (!command.requiresSession || hasSession) && command.name.startsWith(query.toLowerCase()))
}
