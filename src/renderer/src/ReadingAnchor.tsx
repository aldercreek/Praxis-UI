import { Component, type ReactNode, type RefObject } from 'react'

type Props = { container: RefObject<HTMLDivElement | null>; following: RefObject<boolean>; children: ReactNode }
type Anchor = { element: Element; top: number; turn: Element | null }

// Read before React updates the DOM, then preserve the visible text when a
// completed process folds above it. Streaming rows keep their existing nodes.
export class ReadingAnchor extends Component<Props, Record<string, never>, Anchor | null> {
  getSnapshotBeforeUpdate(): Anchor | null {
    const container = this.props.container.current
    if (!container || this.props.following.current) return null
    const viewport = container.getBoundingClientRect()
    const element = [...container.querySelectorAll('.message-assistant .markdown p, .agent-instruction .markdown :is(p, li, h2), .tool-group > summary, .tool-message > summary, .message-user, .process-summary')]
      .find(node => {
        const rect = node.getBoundingClientRect()
        return rect.height > 0 && rect.bottom > viewport.top + 4 && rect.top < viewport.bottom
      })
    return element ? { element, top: element.getBoundingClientRect().top, turn: element.closest('.transcript-turn') } : null
  }

  componentDidUpdate(_previous: Props, _state: Record<string, never>, anchor: Anchor | null) {
    const container = this.props.container.current
    if (!container || !anchor || this.props.following.current) return
    let element = anchor.element
    // A tool stage may fold before the turn finishes. Its own summary is the
    // nearest surviving anchor; a Completed header may not exist yet.
    let parent = element.parentElement
    while (parent && parent !== container) {
      if (parent.matches('details:not([open])')) element = parent.querySelector(':scope > summary') || element
      if (parent.hidden && parent.dataset.processController) element = document.getElementById(parent.dataset.processController) || element
      parent = parent.parentElement
    }
    if (!element.getBoundingClientRect().height) element = anchor.turn?.querySelector('.process-summary') || element
    if (element.isConnected && element.getBoundingClientRect().height) {
      const displacement = element.getBoundingClientRect().top - anchor.top
      // Writing even the unchanged scrollTop cancels an in-progress smooth
      // navigation. Only compensate a real layout shift, not an ordinary render.
      if (Math.abs(displacement) > 0.5) container.scrollTop += displacement
    }
  }

  render() { return this.props.children }
}
