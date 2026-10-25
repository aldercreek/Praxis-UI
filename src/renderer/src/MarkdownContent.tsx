import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { Archive, Check, ChevronRight, Copy, FileCode2, FileImage, FileSpreadsheet, FileText, Presentation } from 'lucide-react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { contentLink, fileName, isAbsoluteFileReference, safeContentUrl } from './fileLinks'
import { containsImage, referenceKind, referenceName, referenceText, rehypeFileReferences } from './fileReferences'

export interface FileNavigation { workspace: string; baseFile?: string; allowRelativeFiles?: boolean; decorateFiles?: boolean; openFile: (path: string) => void; onError: (message: string) => void }
export const FileNavigationContext = createContext<FileNavigation | undefined>(undefined)

function ReferenceName({ name }: { name: string }) {
  const ending = name.match(/(?:\.[a-z\d]{1,12})?(?::\d+(?::\d+)?|#L?\d+(?:-L?\d+)?)?$/i)?.[0] || ''
  const suffix = ending === name ? '' : ending
  return <span className="file-reference-name"><span className="file-reference-stem">{suffix ? name.slice(0, -suffix.length) : name}</span>{suffix && <span className="file-reference-suffix">{suffix}</span>}</span>
}

function ContentLink({ href, children, label, row, imageLink }: { href?: string; children?: React.ReactNode; label: string; row: boolean; imageLink: boolean }) {
  const navigation = useContext(FileNavigationContext)
  const link = href ? contentLink(href, navigation?.baseFile) : undefined
  if (!link) return <span>{children}</span>
  if (link.kind === 'file' && navigation?.decorateFiles !== false && !imageLink) {
    const name = referenceName(href!)
    const description = label && label !== name && label !== href && label !== link.path ? label : ''
    const Icon = { code: FileCode2, image: FileImage, sheet: FileSpreadsheet, slides: Presentation, archive: Archive, document: FileText }[referenceKind(name)]
    const available = Boolean(navigation && (navigation.allowRelativeFiles !== false || isAbsoluteFileReference(link.path)))
    const className = row ? 'file-reference-row' : 'file-reference-inline'
    const location = isAbsoluteFileReference(link.path) ? link.path : `${navigation?.workspace.replace(/[/\\]+$/, '')}/${link.path}`
    const title = available ? [description, location].filter(Boolean).join('\n') : [description, '子任务未提供完整文件路径', link.path].filter(Boolean).join('\n')
    const content = row ? <>
      <span className="file-reference-icon" aria-hidden="true"><Icon size={16} /></span>
      <span className="file-reference-details">
        <span className="file-reference-label">{description ? children : <ReferenceName name={name} />}</span>
        {description && <span className="file-reference-meta"><ReferenceName name={name} /></span>}
      </span>
      {available && <ChevronRight size={13} className="file-reference-arrow" aria-hidden="true" />}
    </> : <><Icon size={13} aria-hidden="true" /><ReferenceName name={name} /></>
    if (!available || !navigation) return <span className={className} title={title} aria-disabled="true">{content}</span>
    return <a href={href} className={className} title={title} aria-label={(row ? [description, name] : [name, description]).filter(Boolean).join(' · ')} onClick={event => { event.preventDefault(); navigation.openFile(link.path) }}>{content}</a>
  }
  if (link.kind === 'file' && navigation?.allowRelativeFiles === false && !isAbsoluteFileReference(link.path)) return <span title="子任务未提供完整文件路径">{children}</span>
  return <a href={href} onClick={event => {
    event.preventDefault()
    if (link.kind === 'file') navigation?.openFile(link.path)
    else if (link.kind === 'external') void window.praxis?.openExternal(link.url).catch(error => navigation?.onError(String(error)))
    else document.getElementById(link.id)?.scrollIntoView({ block: 'nearest' })
  }}>{children}</a>
}

function ContentImage({ src, alt }: { src?: string | Blob; alt?: string }) {
  const navigation = useContext(FileNavigationContext)
  const link = typeof src === 'string' ? contentLink(src, navigation?.baseFile) : undefined
  const path = link?.kind === 'file' && (navigation?.allowRelativeFiles !== false || isAbsoluteFileReference(link.path)) ? link.path : undefined
  const imageKey = `${navigation?.workspace}:${path}`
  const [image, setImage] = useState<{ key: string; url: string }>()
  useEffect(() => {
    if (!path || !navigation?.workspace || !window.praxis) return
    let active = true
    void window.praxis.previewFile({ path, workspace: navigation.workspace }).then(file => {
      if (active && file.kind === 'image' && file.dataUrl) setImage({ key: imageKey, url: file.dataUrl })
    }).catch(() => { if (active) setImage(undefined) })
    return () => { active = false }
  }, [path, navigation?.workspace, imageKey])
  const hasImage = Boolean(image && image.key === imageKey)
  const label = alt || fileName(path || (typeof src === 'string' ? src : '图片'))
  return <button type="button" className={`content-image ${hasImage ? 'has-image' : ''}`} aria-label={`查看图片：${label}`} onClick={() => {
    if (path) navigation?.openFile(path)
    else if (link?.kind === 'external') void window.praxis?.openExternal(link.url).catch(error => navigation?.onError(String(error)))
  }} disabled={!link || link.kind === 'anchor' || link.kind === 'file' && !path}>
    {hasImage && image ? <img src={image.url} alt={label} loading="lazy" /> : <><FileImage size={15} /><span>{label}</span></>}
  </button>
}

function CodeBlock({ children }: { children?: React.ReactNode }) {
  const ref = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)
  return <div className="code-block"><pre ref={ref}>{children}</pre><button className="code-copy" type="button" aria-label="Copy code" title="Copy code" onClick={() => {
    void navigator.clipboard.writeText(ref.current?.innerText || '').then(() => setCopied(true)).catch(() => setCopied(false))
  }}>{copied ? <Check size={13} /> : <Copy size={13} />}</button></div>
}

const components: Components = {
  a: ({ href, children, className, node }) => <ContentLink href={href} label={referenceText(node)} row={className === 'file-reference-row'} imageLink={containsImage(node)}>{children}</ContentLink>,
  img: ({ src, alt }) => <ContentImage src={src} alt={alt} />,
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>
}

const fileReferencePlugins = [rehypeFileReferences]

export function MarkdownContent({ content, allowRelativeFiles = true, decorateFiles = true, streaming = false }: { content: string; allowRelativeFiles?: boolean; decorateFiles?: boolean; streaming?: boolean }) {
  const inherited = useContext(FileNavigationContext)
  const navigation = useMemo(() => inherited ? { ...inherited, decorateFiles, allowRelativeFiles: allowRelativeFiles && inherited.allowRelativeFiles !== false } : undefined, [inherited, allowRelativeFiles, decorateFiles])
  return <FileNavigationContext.Provider value={navigation}><div className="markdown"><Markdown remarkPlugins={[remarkGfm]} rehypePlugins={decorateFiles && !streaming ? fileReferencePlugins : undefined} urlTransform={safeContentUrl} components={components}>{content}</Markdown></div></FileNavigationContext.Provider>
}
