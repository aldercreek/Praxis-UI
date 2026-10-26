import { useEffect, useId, useRef } from 'react'
import { Ellipsis, Trash2, X } from 'lucide-react'
import type { SessionSummary } from '../../shared/protocol'

export function ChatActions({ session, onDelete }: { session: SessionSummary; onDelete: () => void }) {
  const menu = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const id = useId()
  return <>
    <button ref={trigger} type="button" className="icon-button chat-actions" aria-label={`Chat actions: ${session.title || 'New chat'}`}
      aria-haspopup="menu" aria-controls={id} onClick={event => {
        const target = menu.current!
        const bounds = event.currentTarget.getBoundingClientRect()
        target.style.top = `${Math.min(bounds.bottom + 4, window.innerHeight - 54)}px`
        target.style.left = `${Math.max(8, Math.min(bounds.right - 160, window.innerWidth - 168))}px`
        target.showPopover()
        target.querySelector('button')?.focus()
      }}><Ellipsis size={16} /></button>
    <div ref={menu} id={id} popover="auto" role="menu" className="chat-menu">
      <button type="button" role="menuitem" onClick={() => { menu.current?.hidePopover(); trigger.current?.focus(); onDelete() }}><Trash2 size={15} />Delete chat</button>
    </div>
  </>
}

export function DeleteChatDialog({ session, close, confirm }: {
  session: SessionSummary | null; close: () => void; confirm: (id: string) => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  const id = useId()
  useEffect(() => {
    if (session) { ref.current?.showModal(); cancel.current?.focus() }
    else ref.current?.close()
  }, [session?.id])
  const status = session?.status
  return <dialog ref={ref} className="settings-dialog delete-chat-dialog" aria-labelledby={id} aria-describedby={`${id}-description`}
    onCancel={event => { event.preventDefault(); close() }}>
    <div className="dialog-header"><h2 id={id}>Delete chat?</h2><button type="button" className="icon-button" aria-label="Close delete confirmation" onClick={close}><X size={16} /></button></div>
    <div className="delete-chat-body" id={`${id}-description`}>
      <p className="delete-chat-title">{session?.title || 'New chat'}</p>
      <p>{status === 'running' ? 'This chat is running. Deleting it will stop the task and remove its history.'
        : status === 'stopping' ? 'This chat is stopping. Its history will be removed after the task stops.'
        : 'This will permanently remove the chat and its history.'} Files in your workspace will stay.</p>
    </div>
    <div className="dialog-footer"><button ref={cancel} type="button" className="button" onClick={close}>Cancel</button>
      <button type="button" className="button danger" onClick={() => { if (session) confirm(session.id); close() }}>Delete chat</button></div>
  </dialog>
}
