import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUpRight, ChevronRight, FileText, FolderOpen, GitCompareArrows, RotateCw, X } from 'lucide-react'
import type { FilePreview } from '../../shared/protocol'
import { FileNavigationContext, MarkdownContent, type FileNavigation } from './MarkdownContent'
import { fileName } from './fileLinks'
import type { TurnChanges } from './changeSummary'

const PdfPreview = lazy(() => import('./PdfPreview'))
export type PanelTarget = { type: 'file'; path: string; turnId?: string } | { type: 'changes'; turnId: string }

export function FilePanel({ target, workspace, turns, activeTurnId, onTarget, onClose }: {
  target: PanelTarget; workspace: string; turns: TurnChanges[]; activeTurnId?: string
  onTarget: (target: PanelTarget) => void; onClose: () => void
}) {
  const [selectedFiles, setSelectedFiles] = useState<Record<string, string>>({})
  const [actionError, setActionError] = useState('')
  const actionVersion = useRef(0)
  const panel = useRef<HTMLElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const turnId = target.turnId || activeTurnId
  const turn = turns.find(item => item.turnId === turnId)
  const changedFile = turn?.files.find(file => file.id === selectedFiles[turnId || '']) || turn?.files[0]
  const path = target.type === 'file' ? target.path : changedFile?.previewPath
  const navigation = useMemo<FileNavigation>(() => ({ workspace, openFile: path => onTarget({ type: 'file', path, turnId }), onError: setActionError }), [workspace, turnId, onTarget])
  useEffect(() => {
    // Following a document link can remove the focused element. Keep keyboard
    // navigation in the preview while leaving surviving controls focused.
    if (!panel.current?.contains(document.activeElement)) closeButton.current?.focus({ preventScroll: true })
  }, [path, target.type])
  useEffect(() => {
    actionVersion.current += 1
    setActionError('')
    return () => { actionVersion.current += 1 }
  }, [path, target.type])
  const action = async (kind: 'open' | 'reveal') => {
    if (!path) return
    const version = ++actionVersion.current
    setActionError('')
    try {
      if (kind === 'open') await window.praxis.openFile({ path, workspace })
      else await window.praxis.revealFile({ path, workspace })
    } catch (error) { if (version === actionVersion.current) setActionError(String(error instanceof Error ? error.message : error)) }
  }

  return <aside ref={panel} className="artifact-panel" aria-label="文件与改动" onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() }
  }}>
    <div className="artifact-panel-header"><div className="artifact-tabs" role="group" aria-label="查看内容">
      <button type="button" aria-pressed={target.type === 'file'} disabled={!path} onClick={() => path && onTarget({ type: 'file', path, turnId })}><FileText size={14} />文件预览</button>
      <button type="button" aria-pressed={target.type === 'changes'} disabled={!turn?.files.length} onClick={() => turnId && onTarget({ type: 'changes', turnId })}><GitCompareArrows size={14} />{turnId && turnId !== activeTurnId ? '改动' : '本轮改动'}{turn && <span>{turn.files.length}</span>}</button>
    </div><button ref={closeButton} type="button" className="icon-button" aria-label="关闭预览" title="关闭预览 · Esc" onClick={onClose}><X size={16} /></button></div>
    <FileNavigationContext.Provider value={navigation}>
      {target.type === 'changes' ? <>
        <div className="changed-files" aria-label="更改的文件">{turn?.files.map(file => <button type="button" key={file.id} className="changed-file-button" aria-pressed={file.id === changedFile?.id} onClick={() => setSelectedFiles(previous => ({ ...previous, [turnId!]: file.id }))}>
          <FileText size={14} /><span title={file.source ? `子任务 ${file.source} · ${file.path}` : file.path}>{file.path}{file.source && <span className="muted"> · 子任务 {file.source}</span>}</span><small>{file.edits.length > 1 ? `${file.edits.length} 次修改` : `+${file.edits[0].added} −${file.edits[0].removed}`}</small><ChevronRight size={12} />
        </button>)}</div>
        {changedFile ? <><div className="artifact-file-heading"><span title={changedFile.path}>{fileName(changedFile.path)}</span>{path && <button type="button" className="text-action" onClick={() => onTarget({ type: 'file', path, turnId })}>查看当前文件<ArrowUpRight size={13} /></button>}</div>
          {!path && <p className="preview-notice">子任务未提供完整文件路径，当前可查看改动内容。</p>}
          <div className="change-diffs">{changedFile.edits.map((edit, index) => <section className="change-edit" key={edit.id}>
            <div className="change-edit-label"><span>{changedFile.edits.length > 1 ? `第 ${index + 1} 次修改` : '文件改动'}</span><span><i>+{edit.added}</i> <b>−{edit.removed}</b></span></div>
            <pre className="file-diff" tabIndex={0} aria-label={`${changedFile.path} 第 ${index + 1} 次修改`}>{edit.diff.split('\n').map((line, lineIndex) => <span key={lineIndex} className={line.startsWith('+++') || line.startsWith('---') ? 'diff-meta' : line.startsWith('+') ? 'diff-add' : line.startsWith('-') ? 'diff-remove' : line.startsWith('@@') ? 'diff-meta' : ''}>{line || '\u00a0'}</span>)}</pre>
          </section>)}</div></> : <p className="preview-notice">这轮还没有可查看的文件改动。</p>}
      </> : <FilePreviewContent key={target.path} path={target.path} workspace={workspace} navigation={navigation} onOpen={() => void action('open')} onReveal={() => void action('reveal')} />}
    </FileNavigationContext.Provider>
    {actionError && <div className="preview-error" role="alert">{actionError}</div>}
  </aside>
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
    <div className="artifact-file-heading"><span title={file?.path || path}>{file?.name || fileName(path)}</span><small>{size}</small><div className="artifact-file-actions">
      <button type="button" className="icon-button" aria-label="刷新文件" title="刷新文件" disabled={loading} onClick={() => setRevision(value => value + 1)}><RotateCw size={14} /></button>
      <button type="button" className="icon-button" aria-label="在文件夹中显示" title="在文件夹中显示" disabled={!file || loading} onClick={onReveal}><FolderOpen size={15} /></button>
      <button type="button" className="icon-button" aria-label="用默认应用打开" title={file && !file.canOpen ? '可预览或在文件夹中显示' : '用默认应用打开'} disabled={!file?.canOpen || loading} onClick={onOpen}><ArrowUpRight size={15} /></button>
    </div></div>
    <div className={`file-preview ${!loading && !error && file ? `file-preview-${file.kind}` : ''}`}>
    {loading ? <div className="preview-loading" role="status" aria-label="正在读取文件"><i /><i /><i /></div> : error ? <div className="preview-empty"><FileText size={24} /><p>无法预览这个文件</p><span role="alert">{error}</span><button type="button" className="button" onClick={() => setRevision(value => value + 1)}>重试</button></div> : file && <>
      {file.truncated && <p className="preview-notice">文件较大，当前显示前 1 MB。可在默认应用中查看完整内容。</p>}
      <FileNavigationContext.Provider value={fileNavigation}>
        {file.kind === 'markdown' ? <MarkdownContent content={file.text || ''} decorateFiles={false} />
          : file.kind === 'text' ? <pre className="file-text" tabIndex={0}>{file.text || '（空文件）'}</pre>
            : file.kind === 'image' ? <img className="file-image" src={file.dataUrl} alt={file.name} onError={() => setError('图片格式无效或文件已损坏。')} />
              : file.kind === 'pdf' && file.dataUrl ? <Suspense fallback={<p className="preview-notice">正在加载 PDF 预览…</p>}><PdfPreview dataUrl={file.dataUrl} /></Suspense>
                : <div className="preview-empty"><FileText size={28} /><p>{file.name}</p><span>{file.notice || (file.canOpen ? '此文件可在默认应用中查看。' : '此格式暂不支持预览，可在文件夹中查看。')}</span><button type="button" className="button" onClick={file.canOpen ? onOpen : onReveal}>{file.canOpen ? '用默认应用打开' : '在文件夹中显示'}</button></div>}
      </FileNavigationContext.Provider>
    </>}
    </div>
  </>
}
