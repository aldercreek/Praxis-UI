import { describe, expect, it } from 'vitest'
import { stripAnsi } from './ansi'
import { commandOutcome } from './commandOutput'
import type { DisplayMessage } from './state'

describe('plain terminal output', () => {
  it.each([
    ['\x1b[31mError\x1b[0m', 'Error'],
    ['first\x1b[2K\x1b[1Gsecond', 'firstsecond'],
    ['\x1b]0;Window title\x07ready', 'ready'],
    ['\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\', 'link'],
    ['0%\r50%\r100%\r\nDone', '100%\nDone'],
    ['one\nleft\rright\n', 'one\nright\n'],
    ['\x1b[31', ''],
    ['\tplain text\n', '\tplain text\n']
  ])('sanitizes %j', (source, expected) => expect(stripAnsi(source)).toBe(expected))
})

describe('command outcomes', () => {
  const command: DisplayMessage = { id: 'command', role: 'tool', tool_name: 'run_command', content: '', status: 'complete', tool_finished: true }
  it.each([0, 2, -1])('shows exit code %s', code => {
    expect(commandOutcome({ ...command, structured_output: { exit_code: code } })).toEqual({ label: `Exit code ${code}`, error: code !== 0 })
  })
  it('omits absent or null exit codes and identifies a background command', () => {
    expect(commandOutcome(command)).toBeUndefined()
    expect(commandOutcome({ ...command, structured_output: { exit_code: null } })).toBeUndefined()
    expect(commandOutcome({ ...command, status: 'running', structured_output: { exit_code: null } })).toEqual({ label: 'Running in background', error: false })
    expect(commandOutcome({ ...command, status: 'running', tool_finished: false })).toBeUndefined()
  })
})
