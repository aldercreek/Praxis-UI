import { isProcessItem, visibleBodyIds, type TranscriptTurn } from './transcriptPresentation'

export interface ProcessGroup {
  id: string
  kind: 'completed'
  items: string[]
}

/** Describe visibility without moving or replacing any transcript nodes.
 * A finished turn keeps only its main prose anchors, supplementary inputs and
 * notices in view; every other process item folds under one Completed control. */
export function processLayout(turn: TranscriptTurn, keepVisible: ReadonlySet<string> = new Set(), omitted: ReadonlySet<string> = new Set()) {
  const anchors = visibleBodyIds(turn)
  const completed: ProcessGroup = { id: 'completed', kind: 'completed', items: [] }
  const groupByItem = new Map<string, ProcessGroup>()
  for (const item of turn.items) {
    if (omitted.has(item.id) || anchors.has(item.id) || keepVisible.has(item.id) || !isProcessItem(item, turn.finalMessageId)) continue
    completed.items.push(item.id)
    groupByItem.set(item.id, completed)
  }
  return { completed, groupByItem }
}
