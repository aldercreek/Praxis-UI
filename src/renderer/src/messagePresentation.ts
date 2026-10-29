const metadata = /^\[message_id=m(?:[0-9]+|[0-9a-f]{32})(?:, operation_id=op[0-9]+)?\](?:\s+|$)/
const envelopePrefix = '[Agent collaboration messages; source-labelled task data]\n'

export interface AgentReport { sender_id: string; recipient_id: string; content: string; task_summary?: string }

export function readAgentReports(text: string): AgentReport[] | undefined {
  if (!text.startsWith(envelopePrefix)) return
  try {
    const items: unknown = JSON.parse(text.slice(envelopePrefix.length))
    if (Array.isArray(items) && items.length && items.every(item => item && typeof item === 'object'
      && ['sender_id', 'recipient_id', 'content'].every(key => typeof item[key] === 'string'))) return items
  } catch { /* Ordinary text, including incomplete examples, stays intact. */ }
}

export function assistantDisplayText(raw: string, streaming = false, report = false): string {
  let text = raw
  while (metadata.test(text)) text = text.replace(metadata, '')
  if (streaming) {
    const prefix = '[message_id=m'
    const partial = text.match(/^\[message_id=m[0-9a-f]*(?:,(.*))?$/)
    if (text && (prefix.startsWith(text) || (partial && (partial[1] === undefined
      || ' operation_id=op'.startsWith(partial[1]) || /^ operation_id=op[0-9]*$/.test(partial[1]))))) return ''
  }
  if (report) {
    text = text.replace(/^\[Worker run ended; this does not imply task completion\. Read the response for findings, blockers or requests for reassignment\.\]\r?\n/, '')
      .replace(/\r?\nWorking directory: [^\r\n]+\. Files are not automatically integrated into the parent workspace\.$/, '')
  }
  return text
}
