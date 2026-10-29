import { useEffect, useRef, useState } from 'react'
import { GripVertical, LoaderCircle, Navigation2, PencilLine, Trash2 } from './icons'
import { readQuotedInput } from './quotedInput'
import './messageQueue.css'

export interface QueuedInput { command_id: string; content: string }

export function MessageQueue({ items, paused, disabled, onDelete, onEdit, onSend, onReorder }: {
  items: QueuedInput[]; paused: boolean; disabled: boolean
  onDelete: (id: string) => Promise<unknown>; onEdit: (id: string) => Promise<unknown>
  onSend: (id: string) => Promise<unknown>; onReorder: (ids: string[]) => Promise<unknown>
}) {
  const [working, setWorking] = useState<{ id: string; action: string }>()
  const [dragged, setDragged] = useState<string>()
  const [dropIndex, setDropIndex] = useState<number>()
  const list = useRef<HTMLUListElement>(null)
  const inFlight = useRef(false)
  const lastId = items.at(-1)?.command_id
  useEffect(() => { if (list.current) list.current.scrollTop = list.current.scrollHeight }, [lastId])
  if (!items.length) return null
  const unavailable = disabled || Boolean(working)
  const run = async (id: string, action: string, operation: () => Promise<unknown>) => {
    if (disabled || inFlight.current) return
    inFlight.current = true
    setWorking({ id, action })
    try { await operation() } catch { /* The composer displays the request error. */ }
    finally { inFlight.current = false; setWorking(undefined) }
  }
  const move = (id: string, index: number) => {
    const from = items.findIndex(item => item.command_id === id)
    const to = Math.max(0, Math.min(index, items.length - 1))
    if (from < 0 || from === to) return
    const ids = items.map(item => item.command_id)
    ids.splice(from, 1)
    ids.splice(to, 0, id)
    void run(id, 'reorder', () => onReorder(ids))
  }
  return <section className="message-queue" aria-label={paused ? 'Paused messages' : 'Queued messages'}>
    <ul ref={list} className="message-queue-list">
      {items.map((item, index) => {
        const preview = readQuotedInput(item.content)?.text || item.content
        const loading = working?.id === item.command_id
        return <li key={item.command_id} className={`message-queue-item${dragged === item.command_id ? ' is-dragging' : ''}${dropIndex === index ? ' is-drop-target' : ''}`} data-input-id={item.command_id}
          draggable={items.length > 1 && !unavailable}
          onDragStart={event => { setDragged(item.command_id); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', item.command_id) }}
          onDragOver={event => { if (!dragged || unavailable) return; event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDropIndex(index) }}
          onDrop={event => { event.preventDefault(); if (dragged && !unavailable) move(dragged, index); setDragged(undefined); setDropIndex(undefined) }}
          onDragEnd={() => { setDragged(undefined); setDropIndex(undefined) }}>
          <button type="button" className="queue-grip" aria-label={`Reorder message ${index + 1}`} title="Drag to reorder · Alt + ↑ / ↓" disabled={unavailable || items.length < 2}
            onKeyDown={event => { if (event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); move(item.command_id, index + (event.key === 'ArrowUp' ? -1 : 1)) } }}><GripVertical size={16} /></button>
          <span className="queue-preview" title={item.content}>{preview}</span>
          <div className="queue-actions">
            <button type="button" aria-label={loading && working.action === 'send' ? 'Sending message' : 'Send now'} title="Send now" disabled={unavailable} onClick={() => void run(item.command_id, 'send', () => onSend(item.command_id))}>
              {loading ? <LoaderCircle size={20} className="spin" /> : <Navigation2 size={20} />}
            </button>
            <button type="button" aria-label="Edit message" title="Edit message" disabled={unavailable} onClick={() => void run(item.command_id, 'edit', () => onEdit(item.command_id))}><PencilLine size={20} /></button>
            <button type="button" aria-label="Delete message" title="Delete message" disabled={unavailable} onClick={() => void run(item.command_id, 'delete', () => onDelete(item.command_id))}><Trash2 size={20} /></button>
          </div>
        </li>
      })}
    </ul>
  </section>
}
