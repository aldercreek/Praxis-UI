import { describe, expect, it } from 'vitest'
import type { DisplayMessage } from './state'
import type { TranscriptTurn } from './transcriptPresentation'
import { processLayout } from './processLayout'

const message = (id: string, role: DisplayMessage['role'], content = id, patch: Partial<DisplayMessage> = {}): DisplayMessage => ({
  id, role, content, turn_id: 'turn-a', agent_id: 'main', ...patch
})
const turn = (items: DisplayMessage[], patch: Partial<TranscriptTurn> = {}): TranscriptTurn => ({
  id: 'turn-a', items, outcome: 'completed', running: false, hasProcess: true, ...patch
})

describe('completed process layout', () => {
  it('folds every process item under one Completed control and keeps the prose anchors', () => {
    const value = turn([
      message('request', 'user'), message('intro', 'assistant', 'short'), message('before', 'tool'),
      message('explanation', 'assistant', 'The longest main explanation.'), message('check', 'tool'),
      message('progress', 'assistant', 'checked'), message('edit', 'tool'),
      message('answer', 'assistant', 'Done.'), message('after', 'tool')
    ], { finalMessageId: 'answer' })
    const layout = processLayout(value)
    expect(layout.completed.items).toEqual(['intro', 'before', 'check', 'progress', 'edit', 'after'])
    expect([...layout.groupByItem.keys()]).toEqual(['intro', 'before', 'check', 'progress', 'edit', 'after'])
    expect(value.items.map(item => item.id)).toEqual(['request', 'intro', 'before', 'explanation', 'check', 'progress', 'edit', 'answer', 'after'])
  })

  it('keeps supplementary inputs and failures visible while the rest folds', () => {
    const value = turn([
      message('explanation', 'assistant', 'A long explanation to retain.'), message('before-input', 'tool'),
      message('supplement', 'user'), message('after-input', 'tool'),
      message('failure', 'system', 'Failed', { error: true }), message('after-failure', 'tool'),
      message('cancelled', 'system', 'Stopped', { status: 'cancelled' }), message('answer', 'assistant', 'Done.')
    ], { finalMessageId: 'answer' })
    const layout = processLayout(value)
    expect(layout.completed.items).toEqual(['before-input', 'after-input', 'after-failure'])
    for (const id of ['explanation', 'supplement', 'failure', 'cancelled', 'answer']) expect(layout.groupByItem.has(id)).toBe(false)
  })

  it('supports equally long anchors and turns with no main prose', () => {
    const layout = processLayout(turn([
      message('first', 'assistant', 'equal'), message('a', 'tool'), message('second', 'assistant', 'equal'),
      message('b', 'tool'), message('last', 'assistant', 'end')
    ]))
    expect(layout.completed.items).toEqual(['a', 'b'])
    expect(processLayout(turn([message('request', 'user'), message('read', 'tool')])).completed.items).toEqual(['read'])
    expect(processLayout(turn([message('answer', 'assistant')])).groupByItem.size).toBe(0)
  })

  it('does not fold child nodes rendered inside an earlier task card', () => {
    const value = turn([
      message('child-first', 'system', 'Task', { agent_id: 'worker' }),
      message('explanation', 'assistant', 'A long explanation to retain.'),
      message('child-answer', 'assistant', 'Child reply', { agent_id: 'worker' }),
      message('answer', 'assistant', 'Done.')
    ])
    const layout = processLayout(value, new Set(['child-first']), new Set(['child-answer']))
    expect(layout.groupByItem.size).toBe(0)
  })

  it('keeps the region stable when later tools arrive and does not annotate source messages', () => {
    const initial = [message('left', 'assistant', 'Longest response'), message('a', 'tool'), message('right', 'assistant', 'end')]
    const before = processLayout(turn(initial))
    const after = processLayout(turn([...initial.slice(0, -1), message('b', 'tool'), initial.at(-1)!]))
    expect(before.completed.id).toBe(after.completed.id)
    expect(after.completed.items).toEqual(['a', 'b'])
    expect(initial[1]).not.toHaveProperty('group')
  })
})
