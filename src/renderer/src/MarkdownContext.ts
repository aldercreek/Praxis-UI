import { createContext } from 'react'

export const MarkdownStreamingContext = createContext(false)
export const MarkdownSourceContext = createContext('')
export const MarkdownMessageContext = createContext<{ actions: boolean; quoteId?: string }>({ actions: false })
