import { useContext, useLayoutEffect, useRef } from 'react'
import { Blocks, CheckCircle2, ChevronRight, FileText, FileCode2, FolderOpen, Image, Link2, ListChecks, Pencil, Search, Terminal } from './icons'
import { Disclosure, useDisclosure } from './Disclosure'
import { FileNavigationContext } from './MarkdownContent'
import { fileChangePreviewPath } from './changeSummary'
import { isAbsoluteFileReference } from './fileLinks'
import { isChildAgent, textOf, toolStatus, type DisplayMessage } from './state'
import { presentTool, toolFileLabel, type ToolIconKind } from './toolPresentation'
import { FilePathTooltip } from './FilePathTooltip'
import { fileDiffLines } from './fileDiff'

export function ToolIcon({ kind }: { kind: ToolIconKind }) {
  const Icon = { read: FileText, folder: FolderOpen, code: FileCode2, search: Search, edit: Pencil, command: Terminal, image: Image, connection: Link2, plan: ListChecks, tool: Blocks }[kind]
  return <Icon size={14} className="tool-icon" aria-hidden="true" />
}

export function ToolMessage({ message, onExpand }: { message: DisplayMessage; onExpand?: () => void }) {
  const [open, setOpen] = useDisclosure(message.id)
  const files = useContext(FileNavigationContext)
  const tool = presentTool(message)
  const argument = message.arguments || {}
  const isCommand = tool.kind === 'command'
  const isEdit = tool.kind === 'edit'
  const awaiting = tool.status === 'Awaiting approval'
  const running = tool.running || tool.status === 'Queued'
  const attention = ['Failed', 'Denied', 'Stopped', 'Unknown'].includes(tool.status)
  const resultText = message.content !== message.output ? message.content : ''
  const hasDiff = Boolean(message.file_change?.diff)
  const diffLines = hasDiff ? fileDiffLines(message.file_change!.diff) : []
  const path = textOf(message.file_change?.path ?? argument.relative_path ?? argument.path ?? argument.file_path)
  const previewPath = hasDiff ? fileChangePreviewPath(message)
    : path && (!isChildAgent(message.agent_id) || isAbsoluteFileReference(path)) ? path : undefined
  const fileLabel = (isEdit || tool.name === 'read_file') && path && tool.status === 'Complete'
  const output = useRef<HTMLDivElement>(null)
  const followOutput = useRef(true)
  useLayoutEffect(() => {
    const region = output.current
    if (region && followOutput.current) region.scrollTop = region.scrollHeight
  }, [message.output])
  // Pending actions live in the bottom approval card until a decision arrives.
  if (awaiting) return null
  const bodyText = isEdit && running ? textOf(argument.content ?? argument.new_string ?? '') : ''
  const note = tool.status === 'Denied' ? 'Action rejected'
    : tool.status === 'Stopped' ? 'Action stopped'
    : running ? 'Waiting for output' : tool.status === 'Complete' ? 'Ran successfully' : 'No output'
  const showResult = !hasDiff && !bodyText
  return <Disclosure storageKey={message.id} data-message-id={message.id} data-status={toolStatus(message)}
    open={open} onOpenChange={value => { setOpen(value); if (value) onExpand?.() }}
    className={`tool-message ${attention ? 'tool-error' : ''}`}>
    <summary aria-label={tool.summary} title={tool.summary}>
      <span className="tool-head-main">
        <span className={attention ? 'tool-icon-error' : undefined}><ToolIcon kind={tool.icon} /></span>
        {fileLabel ? <>
          <span className="tool-verb">{isEdit ? 'Edit' : 'Read'}</span>
          <FilePathTooltip path={path}>{previewPath
            ? <button type="button" className="tool-file-link" onClick={() => files?.openFile(previewPath)}>{toolFileLabel(path)}</button>
            : <span className="tool-file-link" aria-disabled="true">{toolFileLabel(path)}</span>}</FilePathTooltip>
          {isEdit && message.file_change && <span className="file-stats"><span className="added">+{message.file_change.added}</span><span className="removed">−{message.file_change.removed}</span></span>}
        </> : <span className={`tool-summary${tool.running ? ' text-sweep' : ''}`}>
          {attention ? tool.summary : tool.caption}
        </span>}
        <ChevronRight className="disclosure-icon" size={12} aria-hidden="true" />
      </span>
    </summary>
    <div className={`tool-details ${hasDiff ? 'has-diff' : ''}`}>
      {tool.displayName !== tool.name && <div className="tool-identity"><span>Tool</span><code>{tool.name}</code></div>}
      {showResult && <div className={isCommand ? 'tool-log' : 'tool-content'} ref={output} tabIndex={0} role="region" aria-label={isCommand ? 'Shell output' : 'Tool output'}
        onScroll={event => { const node = event.currentTarget; followOutput.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24 }}>
        {isCommand && tool.command && <><div className="exec-language">{Array.isArray(argument.argv) ? 'command' : 'shell'}</div><pre className="command-line">{tool.command}</pre></>}
        {message.output && <pre className="terminal-output">{message.output}</pre>}
        {resultText && <pre className={attention ? 'tool-result-prose' : undefined}>{resultText}</pre>}
        {!message.output && !resultText && <div className={`tool-waiting ${tool.status === 'Complete' ? 'tool-success' : ''}`}>{tool.status === 'Complete' && <CheckCircle2 size={16} />}{note}</div>}
      </div>}
      {bodyText && <pre className="write-stream">{bodyText}</pre>}
      {hasDiff && <div className="tool-file-change" tabIndex={0} role="region" aria-label="File changes"><pre className="file-diff">{diffLines.map((line, index) => <span key={index}
        className={`diff-${line.kind}`}><span className="diff-sign">{line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' '}</span><span>{line.content || '\u00a0'}</span></span>)}</pre></div>}
      {tool.kind === 'tool' && Object.keys(argument).length > 0 && <Disclosure storageKey={`${message.id}:arguments`} className="tool-arguments">
        <summary><ChevronRight className="disclosure-icon" size={12} aria-hidden="true" />{hasDiff ? 'Details' : 'Arguments'}</summary>
        {hasDiff && message.output && <pre>{message.output}</pre>}{hasDiff && resultText && <pre>{resultText}</pre>}
        {Object.keys(argument).length > 0 && <pre>{JSON.stringify(argument, null, 2)}</pre>}
      </Disclosure>}
    </div>
  </Disclosure>
}
