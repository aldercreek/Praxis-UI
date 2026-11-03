export function tableSource(source: string, position?: { start: { offset?: number }; end: { offset?: number } }): string {
  const start = position?.start.offset
  const end = position?.end.offset
  return typeof start === 'number' && typeof end === 'number' && start >= 0 && end >= start && end <= source.length ? source.slice(start, end) : ''
}

export function cleanTableHtml(table: HTMLTableElement): string {
  const clone = table.cloneNode(true) as HTMLTableElement
  clone.querySelectorAll('button, script, style, [aria-hidden="true"]').forEach(element => element.remove())
  const tags = new Set(['TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TH', 'TD', 'CAPTION'])
  for (const element of [clone, ...clone.querySelectorAll('*')].reverse()) {
    if (!tags.has(element.tagName)) { element.replaceWith(table.ownerDocument.createTextNode(element.textContent || '')); continue }
    for (const attribute of [...element.attributes]) {
      if (!['colspan', 'rowspan'].includes(attribute.name) || !/^\d{1,3}$/.test(attribute.value)) element.removeAttribute(attribute.name)
    }
  }
  return clone.outerHTML
}

export async function copyTable(markdown: string, table: HTMLTableElement): Promise<void> {
  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard.write) {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': new Blob([markdown], { type: 'text/plain' }), 'text/html': new Blob([cleanTableHtml(table)], { type: 'text/html' }) })])
      return
    } catch {}
  }
  await navigator.clipboard.writeText(markdown)
}
