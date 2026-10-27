import { isProcessItem, visibleBodyIds, type TranscriptTurn } from './transcriptPresentation'

export interface ProcessGroup {
  id: string
  kind: 'completed' | 'middle'
  items: string[]
}

/** Describe visibility without moving or replacing any transcript nodes. */
export function processLayout(turn: TranscriptTurn, keepVisible: ReadonlySet<string> = new Set(), omitted: ReadonlySet<string> = new Set()) {
  const anchors = visibleBodyIds(turn)
  const completed: ProcessGroup = { id: 'completed', kind: 'completed', items: [] }
  const middle: ProcessGroup[] = []
  const groupByItem = new Map<string, ProcessGroup>()
  let passedAnchors = 0
  let currentMiddle: ProcessGroup | undefined

  for (const item of turn.items) {
    if (omitted.has(item.id)) continue
    if (anchors.has(item.id)) {
      passedAnchors += 1
      currentMiddle = undefined
      continue
    }
    if (keepVisible.has(item.id) || !isProcessItem(item, turn.finalMessageId)) {
      // User supplements and error notices stay in place. A process on their
      // other side gets its own control rather than hiding across that boundary.
      currentMiddle = undefined
      continue
    }
    let group = completed
    if (passedAnchors > 0 && passedAnchors < anchors.size) {
      if (!currentMiddle) {
        currentMiddle = { id: `middle:${item.id}`, kind: 'middle', items: [] }
        middle.push(currentMiddle)
      }
      group = currentMiddle
    }
    group.items.push(item.id)
    groupByItem.set(item.id, group)
  }
  return { completed, middle, groupByItem }
}
