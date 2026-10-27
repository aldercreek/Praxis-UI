const quotePrefix = 'Quoted response:\n'

export function formatQuotedInput(text: string, quote?: { text: string }): string {
  if (!quote) return text
  return `${quotePrefix}${quote.text.replaceAll('\r\n', '\n').split('\n').map(line => `> ${line}`).join('\n')}\n\n${text}`
}

export function readQuotedInput(content: string): { quote: string; text: string } | undefined {
  // Recognize previously saved quotes without changing their original content.
  const prefix = [quotePrefix, '引用助手回复：\n'].find(value => content.startsWith(value))
  if (!prefix) return
  const end = content.indexOf('\n\n', prefix.length)
  if (end < 0) return
  const lines = content.slice(prefix.length, end).split('\n')
  if (!lines.length || lines.some(line => !line.startsWith('> '))) return
  return { quote: lines.map(line => line.slice(2)).join('\n'), text: content.slice(end + 2) }
}
