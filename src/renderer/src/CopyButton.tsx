import { useEffect, useRef, useState } from 'react'
import { Check, Copy } from './icons'

export function CopyButton({ text, label = 'Copy', size = 16, className = 'icon-button' }: { text: string; label?: string; size?: number; className?: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  return <button type="button" className={className} aria-label={copied ? 'Copied' : label} title={copied ? 'Copied' : label} onClick={() => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 1800)
    }).catch(() => setCopied(false))
  }}>{copied ? <Check size={size} /> : <Copy size={size} />}</button>
}
