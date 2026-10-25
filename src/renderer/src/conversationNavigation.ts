import { isChildAgent, type DisplayMessage } from './state'
import { readQuotedInput } from './quotedInput'

export interface ConversationAnchor {
  messageId: string
  bookmarkKey: string
  question: string
  answer: string
}

function excerpt(text: string): string {
  return text.replace(/```[^\n]*\n?/g, '').replace(/!?\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?)/gm, '').replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim().slice(0, 600)
}

// Live optimistic IDs and IDs restored from history can differ. Hash the exact
// prompt with its occurrence so bookmarks survive reloads and repeated prompts
// remain independent, without copying private conversation text into storage.
function promptKey(text: string): string {
  let first = 2166136261
  let second = 5381
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    first = Math.imul(first ^ code, 16777619)
    second = Math.imul(second, 33) ^ code
  }
  return (first >>> 0).toString(36) + '-' + (second >>> 0).toString(36)
}

export function conversationAnchors(messages: DisplayMessage[]): ConversationAnchor[] {
  const anchors: ConversationAnchor[] = []
  const occurrences = new Map<string, number>()
  for (const message of messages) {
    if (isChildAgent(message.agent_id)) continue
    if (message.role === 'user' && message.content.trim()) {
      const hash = promptKey(message.content.replaceAll('\r\n', '\n'))
      const occurrence = occurrences.get(hash) || 0
      occurrences.set(hash, occurrence + 1)
      anchors.push({ messageId: message.id, bookmarkKey: hash + ':' + occurrence,
        question: excerpt(readQuotedInput(message.content)?.text || message.content), answer: '' })
    } else if (message.role === 'assistant' && message.content.trim() && anchors.length) {
      anchors[anchors.length - 1].answer = excerpt(message.content)
    }
  }
  return anchors
}

export function readBookmarks(storageKey: string): Set<string> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey) || '[]')
    return new Set(Array.isArray(value) ? value.filter((key): key is string => typeof key === 'string') : [])
  } catch { return new Set() }
}
