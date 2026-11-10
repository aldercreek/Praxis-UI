import { useContext } from 'react'
import { CopyButton } from './CopyButton'
import { FileNavigationContext } from './MarkdownContent'
import { FilePathTooltip } from './FilePathTooltip'
import { isAbsoluteFileReference } from './fileLinks'
import { pythonResult } from './pythonOutput'
import { stripAnsi } from './ansi'
import { textOf, toolStatus, type DisplayMessage } from './state'

export function PythonExecution({ message }: { message: DisplayMessage }) {
  const navigation = useContext(FileNavigationContext)
  const result = pythonResult(message)
  const code = textOf(message.arguments?.code)
  const status = toolStatus(message)
  const running = ['pending', 'running', 'approval'].includes(status || '')
  const stopped = status === 'cancelled'
  const sections = result ? [
    ['Output', textOf(result.stdout)],
    ['Error output', textOf(result.stderr)],
    ['Result', textOf(result.result)],
    ['Error', stopped ? '' : textOf(result.error)]
  ].filter(([, value]) => value) : [['Output', message.content || message.output || '']].filter(([, value]) => value)
  const outputFiles = result?.output_files
  const logs = outputFiles && typeof outputFiles === 'object' && !Array.isArray(outputFiles)
    ? Object.entries(outputFiles).flatMap(([stream, value]) => {
      if (!['stdout', 'stderr'].includes(stream) || !value || typeof value !== 'object') return []
      const reference = value as Record<string, unknown>
      return typeof reference.path === 'string' && isAbsoluteFileReference(reference.path)
        ? [{ stream, path: reference.path, incomplete: reference.complete === false }] : []
    }) : []
  const copiedOutput = sections.map(([, value]) => stripAnsi(value)).join('\n')
  return <div className="tool-log python-execution" tabIndex={0} role="region" aria-label="Python execution">
    <div className="exec-language"><span>python</span><span className="command-actions">
      {code && <CopyButton text={code} label="Copy Python code" size={14} className="code-copy" />}
      {copiedOutput && <CopyButton text={copiedOutput} label="Copy Python output" size={14} className="code-copy" />}
    </span></div>
    {code && <pre className="command-line" aria-label="Python code">{code}</pre>}
    {sections.map(([label, value]) => <div className="python-output-section" key={label}>
      <div className="python-output-label">{label}</div>
      <pre className={label === 'Error' ? 'error-text' : 'terminal-output'} aria-label={`Python ${label.toLowerCase()}`}>{stripAnsi(value)}</pre>
    </div>)}
    {!sections.length && <div className="tool-waiting">{running ? 'Waiting for output' : stopped ? 'Execution stopped' : status === 'failed' ? 'Execution failed' : status === 'denied' ? 'Action rejected' : 'Completed without output'}</div>}
    {logs.map(log => <div className="python-log-reference" key={log.stream}>
      <FilePathTooltip path={log.path}><button type="button" className="tool-file-link" disabled={!navigation}
        onClick={() => navigation?.openFile(log.path)}>Open {log.stream} log</button></FilePathTooltip>
      {log.incomplete && <span className="tool-waiting">Saved log is truncated</span>}
    </div>)}
  </div>
}
