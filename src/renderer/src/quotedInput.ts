export function formatQuotedInput(text: string, quote?: { text: string }): string {
  if (!quote) return text
  return `引用助手回复：\n${quote.text.replaceAll('\r\n', '\n').split('\n').map(line => `> ${line}`).join('\n')}\n\n${text}`
}

export function readQuotedInput(content: string): { quote: string; text: string } | undefined {
  const prefix = '引用助手回复：\n'
  if (!content.startsWith(prefix)) return
  const end = content.indexOf('\n\n', prefix.length)
  if (end < 0) return
  const lines = content.slice(prefix.length, end).split('\n')
  if (!lines.length || lines.some(line => !line.startsWith('> '))) return
  return { quote: lines.map(line => line.slice(2)).join('\n'), text: content.slice(end + 2) }
}
