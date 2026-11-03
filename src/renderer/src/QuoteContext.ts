import { createContext } from 'react'
import type { TextQuote } from './quote'

export const QuoteContext = createContext<{ addQuote: (quote: TextQuote) => void; disabled: boolean } | undefined>(undefined)
