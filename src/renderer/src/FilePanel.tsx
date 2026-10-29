import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowUpRight, FileText, FolderOpen, FileDiff, RotateCw, X } from './icons'
import type { FilePreview } from '../../shared/protocol'
import { FileNavigationContext, MarkdownContent, type FileNavigation } from './MarkdownContent'
import { fileName, isAbsoluteFileReference } from './fileLinks'
import type { ChangedFile, FileEdit, TurnChanges } from './changeSummary'
import { fileDiffLines } from './fileDiff'
import './filePanel.css'

const PdfPreview = lazy(() => import('./PdfPreview'))
export type PanelTarget = { type: 'file'; path: string; turnId?: string } | { type: 'changes'; turnId: string; fileId?: string }

export function FilePanel({ target, workspace, turns, activeTurnId, onTarget, onClose }: {
  target: PanelTarget; workspace: string; turns: TurnChanges[]; activeTurnId?: string
  onTarget: (target: PanelTarget) => void; onClose: () => void
}) {
  const [actionError, setActionError] = useState('')
  const actionVersion = useRef(0)
  const panel = useRef<HTMLElement>(null)
  const diffContent = useRef<HTMLDivElement>(null)
  const fileRegions = useRef(new Map<string, HTMLElement>())
  const closeButton = useRef<HTMLButtonElement>(null)
  const turnId = target.turnId || activeTurnId
  const turn = turns.find(item => item.turnId === turnId)
  const path = target.type === 'file' ? target.path : undefined
  const edits = turn?.files.flatMap(file => file.edits) || []
  const navigation = useMemo<FileNavigation>(() => ({ workspace, openFile: path => onTarget({ type: 'file', path, turnId }), onError: setActionError }), [workspace, turnId, onTarget])
  useEffect(() => {
    // Following a document link can remove the focused element. Keep keyboard
    // navigation in the preview while leaving surviving controls focused.
    if (!panel.current?.contains(document.activeElement)) closeButton.current?.focus({ preventScroll: true })
  }, [target, turnId])
  useLayoutEffect(() => {
    const container = diffContent.current
    if (target.type !== 'changes' || !container) return
    const file = target.fileId ? fileRegions.current.get(target.fileId) : undefined
    container.scrollTop = file ? container.scrollTop + file.getBoundingClientRect().top - container.getBoundingClientRect().top - 16 : 0
  }, [target, turn?.files.length])
  useEffect(() => {
    actionVersion.current += 1
    setActionError('')
    return () => { actionVersion.current += 1 }
  }, [path, target.type, turnId])
  const action = async (kind: 'open' | 'reveal') => {
    if (!path) return
    const version = ++actionVersion.current
    setActionError('')
    try {
      if (kind === 'open') await window.praxis.openFile({ path, workspace })
      else await window.praxis.revealFile({ path, workspace })
    } catch (error) { if (version === actionVersion.current) setActionError(String(error instanceof Error ? error.message : error)) }
  }

  return <aside ref={panel} className="artifact-panel praxis-file-panel" aria-label="Files and changes" onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() }
  }}>
    <div className="diff-header">
      {target.type === 'changes' ? <><span>File changes</span><DiffStats edits={edits} /></> : <>
        <span>File contents</span>{turn?.files.length && turnId ? <button type="button" className="diff-return" onClick={() => onTarget({ type: 'changes', turnId })}><FileDiff size={14} />Changes for this turn</button> : null}
      </>}
      <button ref={closeButton} type="button" className="icon-button" aria-label="Close preview" title="Close preview · Esc" onClick={onClose}><X size={16} /></button>
    </div>
    <FileNavigationContext.Provider value={navigation}>
      {target.type === 'changes' ? <>
        <div ref={diffContent} className="diff-content" aria-label="Changed files">{turn?.files.length ? turn.files.map(file => <section className="diff-file" key={file.id} data-file-path={file.path} data-file-id={file.id}
          ref={node => { if (node) fileRegions.current.set(file.id, node); else fileRegions.current.delete(file.id) }}>
          <div className="diff-filename"><FileText size={16} />
            {file.previewPath ? <button type="button" title="View current file" onClick={() => onTarget({ type: 'file', path: file.previewPath!, turnId })}>{fileName(file.path)}</button> : <span>{fileName(file.path)}</span>}
            <DiffStats edits={file.edits} />
          </div>
          <div className="diff-path">{fullDisplayPath(file, workspace)}{file.source && <span> · Subtask {file.source}</span>}</div>
          <div className="change-diffs">{file.edits.map((edit, index) => <section className="change-edit" key={edit.id}>
            {file.edits.length > 1 && <div className="change-edit-label"><span>Edit {index + 1}</span><DiffStats edits={[edit]} /></div>}
            <pre className="file-diff diff-lines" tabIndex={0} aria-label={`${file.path} edit ${index + 1}`}>{fileDiffLines(edit.diff).map((line, lineIndex) => <span key={lineIndex} className={`diff-line ${line.kind}`}>
              <span className="line-number" aria-hidden="true">{line.number ?? ''}</span><span className="sign" aria-hidden="true">{line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '}</span><span className="diff-code">{line.content || '\u00a0'}</span>
            </span>)}</pre>
          </section>)}</div>
        </section>) : <p className="preview-notice">No file changes in this turn yet.</p>}</div>
        <div className="diff-footer">{turn?.files.length || 0} {turn?.files.length === 1 ? 'file' : 'files'} changed</div>
      </> : <FilePreviewContent key={target.path} path={target.path} workspace={workspace} navigation={navigation} onOpen={() => void action('open')} onReveal={() => void action('reveal')} />}
    </FileNavigationContext.Provider>
    {actionError && <div className="preview-error" role="alert">{actionError}</div>}
  </aside>
}

function DiffStats({ edits }: { edits: FileEdit[] }) {
  const added = edits.reduce((total, edit) => total + edit.added, 0)
  const removed = edits.reduce((total, edit) => total + edit.removed, 0)
  return <span className="file-stats" title="Total lines changed"><span className="added">+{added}</span><span className="removed">−{removed}</span></span>
}

function fullDisplayPath(file: ChangedFile, workspace: string): string {
  if (!file.previewPath || !workspace || isAbsoluteFileReference(file.previewPath)) return file.path
  const windows = /^[a-z]:[/\\]/i.test(workspace)
  const combined = `${workspace.replaceAll('\\', '/').replace(/\/$/, '')}/${file.previewPath.replaceAll('\\', '/')}`
  const parts: string[] = []
  for (const part of combined.split('/')) {
    if (part === '.') continue
    if (part === '..' && parts.length > 1) parts.pop()
    else parts.push(part)
  }
  return parts.join(windows ? '\\' : '/')
}

function FilePreviewContent({ path, workspace, navigation, onOpen, onReveal }: {
  path: string; workspace: string; navigation: FileNavigation; onOpen: () => void; onReveal: () => void
}) {
  const [file, setFile] = useState<FilePreview>()
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let active = true
    setLoading(true)
    setError('')
    void window.praxis.previewFile({ path, workspace }).then(value => { if (active) setFile(value) }).catch(reason => {
      if (active) { setFile(undefined); setError(String(reason instanceof Error ? reason.message : reason)) }
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [path, workspace, revision])
  const fileNavigation = useMemo(() => ({ ...navigation, baseFile: file?.path }), [navigation, file?.path])
  const size = file ? file.size < 1024 ? `${file.size} B` : file.size < 1024 * 1024 ? `${(file.size / 1024).toFixed(1)} KB` : `${(file.size / 1024 / 1024).toFixed(1)} MB` : ''
  return <>
    <div className="artifact-file-heading"><FileText size={16} /><span title={file?.path || path}>{file?.name || fileName(path)}</span><small>{size}</small><div className="artifact-file-actions">
      <button type="button" className="icon-button" aria-label="Refresh file" title="Refresh file" disabled={loading} onClick={() => setRevision(value => value + 1)}><RotateCw size={16} /></button>
      <button type="button" className="icon-button" aria-label="Show in folder" title="Show in folder" disabled={!file || loading} onClick={onReveal}><FolderOpen size={16} /></button>
      <button type="button" className="icon-button" aria-label="Open in default app" title={file && !file.canOpen ? 'Preview or show in folder' : 'Open in default app'} disabled={!file?.canOpen || loading} onClick={onOpen}><ArrowUpRight size={16} /></button>
    </div></div>
    <div className="diff-path">{file?.path || path}</div>
    <div className={`file-preview ${!loading && !error && file ? `file-preview-${file.kind}` : ''}`}>
    {loading ? <div className="preview-loading" role="status" aria-label="Loading file"><i /><i /><i /></div> : error ? <div className="preview-empty"><FileText size={24} /><p>Unable to preview this file</p><span role="alert">{error}</span><button type="button" className="button" onClick={() => setRevision(value => value + 1)}>Retry</button></div> : file && <>
      {file.truncated && <p className="preview-notice">Showing the first 1 MB. Open in the default app to view the full file.</p>}
      <FileNavigationContext.Provider value={fileNavigation}>
        {file.kind === 'markdown' ? <MarkdownContent content={file.text || ''} decorateFiles={false} />
          : file.kind === 'text' ? <pre className="file-text" tabIndex={0}>{file.text || '(Empty file)'}</pre>
            : file.kind === 'image' ? <img className="file-image" src={file.dataUrl} alt={file.name} onError={() => setError('Invalid image format or damaged file.')} />
              : file.kind === 'pdf' && file.dataUrl ? <Suspense fallback={<p className="preview-notice">Loading PDF preview…</p>}><PdfPreview dataUrl={file.dataUrl} /></Suspense>
                : <div className="preview-empty"><FileText size={24} /><p>{file.name}</p><span>{file.notice || (file.canOpen ? 'Open this file in the default app.' : 'Preview is unavailable for this format. You can show the file in its folder.')}</span><button type="button" className="button" onClick={file.canOpen ? onOpen : onReveal}>{file.canOpen ? 'Open in default app' : 'Show in folder'}</button></div>}
      </FileNavigationContext.Provider>
    </>}
    </div>
  </>
}
