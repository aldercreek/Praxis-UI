import { useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { Element } from 'hast'
import { Check, Copy, Quote } from './icons'
import { MarkdownMessageContext, MarkdownSourceContext, MarkdownStreamingContext } from './MarkdownContext'
import { QuoteContext } from './QuoteContext'
import { tableQuoteText } from './quote'
import { copyTable, tableSource } from './tableActions'

export function MarkdownTable({ node, children }: { node?: Element; children?: ReactNode }) {
  const source = useContext(MarkdownSourceContext)
  const streaming = useContext(MarkdownStreamingContext)
  const message = useContext(MarkdownMessageContext)
  const quote = useContext(QuoteContext)
  const table = useRef<HTMLTableElement>(null)
  const [copied, setCopied] = useState(false)
  const markdown = tableSource(source, node?.position)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1800)
    return () => clearTimeout(timer)
  }, [copied])
  return <div className="markdown-table">
    <div className="table-wrap"><table ref={table}>{children}</table></div>
    {message.actions && !streaming && markdown && <div className="table-actions">
      <button type="button" className="code-copy" aria-label={copied ? 'Copied' : 'Copy table'} title="Copy table" onClick={() => {
        if (table.current) void copyTable(markdown, table.current).then(() => setCopied(true)).catch(() => setCopied(false))
      }}>{copied ? <Check size={14} /> : <Copy size={14} />}</button>
      {quote && message.quoteId && <button type="button" className="code-copy" aria-label="Quote table" title="Quote table" disabled={quote.disabled} onClick={() => quote.addQuote({ text: tableQuoteText(markdown), messageId: message.quoteId! })}><Quote size={14} /></button>}
    </div>}
  </div>
}
