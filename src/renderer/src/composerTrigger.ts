export interface ComposerTrigger { kind: 'command' | 'file'; query: string; start: number }

export function detectTrigger(text: string, caret: number): ComposerTrigger | undefined {
  if (caret < 0 || caret > text.length) return
  if (text.startsWith('/') && !/\s/.test(text) && caret > 0) return { kind: 'command', query: text.slice(1, caret), start: 0 }
  const before = text.slice(0, caret)
  const match = before.match(/(?:^|\s)@([^\s@]*)$/u)
  if (match) return { kind: 'file', query: match[1], start: before.length - match[1].length - 1 }
}

export function applyFileMention(text: string, trigger: ComposerTrigger, caret: number, path: string): { text: string; caret: number } {
  const mention = `@${path.replaceAll('\\', '/')} `
  return { text: text.slice(0, trigger.start) + mention + text.slice(caret), caret: trigger.start + mention.length }
}
