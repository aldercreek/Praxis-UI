import { useEffect, useId, useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { SessionSnapshot, SessionSummary, TranscriptMessage } from '../../shared/protocol'
import { isChildAgent } from './state'
import { errorMessage, usePraxis } from './usePraxis'

export function ShareChatDialog({ session, praxis, close }: {
  session: SessionSummary
  praxis: ReturnType<typeof usePraxis>
  close: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const id = useId()
  const [messages, setMessages] = useState<TranscriptMessage[]>([])
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [copying, setCopying] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const copyTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const current = useRef(praxis)
  const mounted = useRef(true)
  current.current = praxis

  useEffect(() => {
    mounted.current = true
    dialog.current?.showModal()
    return () => { mounted.current = false; clearTimeout(copyTimer.current) }
  }, [])

  useEffect(() => {
    let active = true
    setLoading(true)
    setError('')
    const load = async () => {
      try {
        const state = current.current
        const conversation = state.conversations[session.id]
        const source = conversation?.loaded ? conversation.messages
          : (await state.api.request<SessionSnapshot>('session.open', { session_id: session.id })).messages
        if (!active) return
        const shareable = source.filter(message => ['user', 'assistant'].includes(message.role) && !isChildAgent(message.agent_id) && message.content.trim())
        setMessages(shareable)
        setSelected(new Set(shareable.map((_, index) => index)))
      } catch (reason) {
        if (active) setError(errorMessage(reason))
      } finally {
        if (active) setLoading(false)
      }
    }
    void load()
    return () => { active = false }
  }, [session.id, attempt])

  const copy = async () => {
    setCopying(true)
    setError('')
    const text = messages.filter((_, index) => selected.has(index)).map(message => message.content).join('\n\n')
    try {
      await navigator.clipboard.writeText(text)
      if (!mounted.current) return
      setCopied(true)
      clearTimeout(copyTimer.current)
      copyTimer.current = setTimeout(() => setCopied(false), 1800)
    } catch (reason) {
      if (mounted.current) setError(errorMessage(reason))
    } finally {
      if (mounted.current) setCopying(false)
    }
  }

  return <dialog ref={dialog} className="praxis-dialog ps-share-dialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`}
    onCancel={event => { event.preventDefault(); close() }}>
    <div className="ps-share-header"><h2 id={`${id}-title`}>Share chat</h2><button type="button" aria-label="Close" onClick={close}><X size={16} /></button></div>
    <div className="ps-share-body">
      <p id={`${id}-description`} className="ps-share-description">Select messages to copy and share.</p>
      {loading ? <p className="ps-share-status" role="status">Loading messages…</p> : <>
        {messages.length > 0 ? <>
          <div className="ps-share-messages">{messages.map((message, index) => <label className="ps-share-message" key={`${message.id}:${index}`}>
            <input type="checkbox" checked={selected.has(index)} aria-label={`Select message ${index + 1} from ${message.role === 'user' ? 'you' : 'Praxis'}`} onChange={event => {
              const checked = event.target.checked
              setSelected(previous => { const next = new Set(previous); if (checked) next.add(index); else next.delete(index); return next })
              setCopied(false)
            }} /><span>{message.content}</span>
          </label>)}</div></> : !error && <p className="ps-share-status">No messages to share yet.</p>}
      </>}
      {error && <div className="ps-share-error" role="alert"><span>{error}</span>{!messages.length && <button type="button" onClick={() => setAttempt(value => value + 1)}>Retry</button>}</div>}
    </div>
    <div className="ps-share-actions">
      <span role="status" className="ps-share-announcement">{copied ? 'Copied to clipboard' : ''}</span>
      <button type="button" onClick={close}>Cancel</button><button type="button" className="ps-share-copy" disabled={loading || copying || selected.size === 0} onClick={() => void copy()}>
        {copying ? 'Copying…' : copied ? 'Copied' : 'Copy selected'}
      </button>
    </div>
  </dialog>
}
