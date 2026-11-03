export interface TextSegment { node: Text; start: number; end: number }
export interface TextMatch { start: number; end: number }

export const findExclusions = '[aria-hidden="true"]:not(.katex-html), button, input, textarea, svg, script, style, .sr-only, .visually-hidden, .katex-mathml, .code-block-header, .exec-language, .message-actions, .markdown-table-actions, .agent-section-label, .turn-time, .message-label, .command-outcome, .empty-state, .transcript-skeleton'
const blocks = 'p, pre, li, td, th, h1, h2, h3, h4, h5, h6, blockquote, summary, .message, .tool-command, .tool-content, .tool-log, .diff-line'

export function collectText(roots: Element[], exclude = findExclusions): { text: string; segments: TextSegment[] } {
  let text = ''
  const segments: TextSegment[] = []
  for (const root of roots) {
    let previousBlock: Element | null | undefined
    if (text) text += '\n'
    const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: node => node.parentElement?.closest(exclude) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
    })
    let node: Node | null
    while ((node = walker.nextNode())) {
      if (!node.textContent) continue
      const block = node.parentElement?.closest(blocks)
      if (previousBlock !== undefined && block !== previousBlock) text += '\n'
      previousBlock = block
      const start = text.length
      text += node.textContent
      segments.push({ node: node as Text, start, end: text.length })
    }
  }
  return { text, segments }
}

export function findMatches(text: string, query: string, limit = 1000): TextMatch[] {
  if (!query || limit <= 0) return []
  const expression = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu')
  const matches: TextMatch[] = []
  let match: RegExpExecArray | null
  while (matches.length < limit && (match = expression.exec(text))) matches.push({ start: match.index, end: match.index + match[0].length })
  return matches
}

export function toRanges(matches: TextMatch[], segments: TextSegment[]): Range[] {
  const segmentAt = (offset: number) => {
    let left = 0
    let right = segments.length - 1
    while (left <= right) {
      const middle = (left + right) >>> 1
      const segment = segments[middle]
      if (offset < segment.start) right = middle - 1
      else if (offset >= segment.end) left = middle + 1
      else return segment
    }
  }
  return matches.flatMap(match => {
    const start = segmentAt(match.start)
    const end = segmentAt(match.end - 1)
    if (!start || !end) return []
    const range = start.node.ownerDocument.createRange()
    range.setStart(start.node, match.start - start.start)
    range.setEnd(end.node, match.end - end.start)
    return [range]
  })
}

export function scrollToMatch(range: Range): void {
  const target = range.startContainer.parentElement
  target?.scrollIntoView({ block: 'center' })
  for (let parent = target; parent; parent = parent.parentElement) {
    if (parent.scrollHeight <= parent.clientHeight || !['auto', 'scroll'].includes(getComputedStyle(parent).overflowY)) continue
    const match = range.getBoundingClientRect()
    const viewport = parent.getBoundingClientRect()
    if (match.top < viewport.top || match.bottom > viewport.bottom) parent.scrollTop += match.top + match.height / 2 - viewport.top - parent.clientHeight / 2
  }
}
