import { describe, expect, it } from 'vitest'
import { composerCommands, matchCommands } from './composerCommands'

describe('composer commands', () => {
  it('matches prefixes without case sensitivity', () => {
    expect(matchCommands('SE', true).map(command => command.name)).toEqual(['settings'])
    expect(matchCommands('etting', true)).toEqual([])
    expect(matchCommands('', true)).toEqual(composerCommands)
  })

  it('hides session-only commands when there is no active chat', () => {
    expect(matchCommands('', false).map(command => command.name)).toEqual(['new', 'settings', 'mcp'])
    expect(matchCommands('delete', false)).toEqual([])
    expect(matchCommands('delete', true)[0].requiresSession).toBe(true)
  })
})
