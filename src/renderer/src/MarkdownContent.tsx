import { createContext, memo, useContext, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Archive, Check, Copy, FileCode2, FileImage, FileSpreadsheet, FileText, Minus, Plus, Presentation, RotateCw } from './icons'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import type { PluggableList } from 'unified'
import remend from 'remend'
import { contentLink, fileName, isAbsoluteFileReference, safeContentUrl } from './fileLinks'
import { containsImage, referenceKind, referenceName, referenceText, rehypeFileReferences } from './fileReferences'
import { FilePathTooltip } from './FilePathTooltip'
import type { TurnChanges } from './changeSummary'
import { fileReferenceChange } from './fileReferenceChange'
import { diagramMarkup, renderDiagram } from './mermaidDiagram'
import { MarkdownMessageContext, MarkdownSourceContext, MarkdownStreamingContext } from './MarkdownContext'
import { MarkdownTable } from './MarkdownTable'
import { ImageLightbox } from './ImageLightbox'
import { ImagePreviewTooltip } from './ImagePreviewTooltip'
import 'katex/dist/katex.min.css'
import './markdownExtras.css'

export interface FileNavigation { workspace: string; baseFile?: string; allowRelativeFiles?: boolean; decorateFiles?: boolean; openFile: (path: string) => void; onError: (message: string) => void }
export const FileNavigationContext = createContext<FileNavigation | undefined>(undefined)
export const FileChangesContext = createContext<{ changes?: TurnChanges; openChanges: (turnId: string, fileId?: string) => void } | undefined>(undefined)

function ReferenceName({ name }: { name: string }) {
  const ending = name.match(/(?:\.[a-z\d]{1,12})?(?::\d+(?::\d+)?|#L?\d+(?:-L?\d+)?)?$/i)?.[0] || ''
  const suffix = ending === name ? '' : ending
  return <span className="file-reference-name"><span className="file-reference-stem">{suffix ? name.slice(0, -suffix.length) : name}</span>{suffix && <span className="file-reference-suffix">{suffix}</span>}</span>
}

function ContentLink({ href, children, label, row, imageLink }: { href?: string; children?: React.ReactNode; label: string; row: boolean; imageLink: boolean }) {
  const navigation = useContext(FileNavigationContext)
  const turnFiles = useContext(FileChangesContext)
  const link = href ? contentLink(href, navigation?.baseFile) : undefined
  if (!link) return <span>{children}</span>
  if (link.kind === 'file' && navigation?.decorateFiles !== false && !imageLink) {
    const name = referenceName(href!)
    const description = label && label !== name && label !== href && label !== link.path ? label : ''
    const Icon = { code: FileCode2, image: FileImage, sheet: FileSpreadsheet, slides: Presentation, archive: Archive, document: FileText }[referenceKind(name)]
    const available = Boolean(navigation && (navigation.allowRelativeFiles !== false || isAbsoluteFileReference(link.path)))
    const matched = row ? fileReferenceChange(link.path, navigation?.workspace || '', turnFiles?.changes, available) : undefined
    const change = matched?.file
    const totals = change?.edits.reduce((sum, edit) => ({ added: sum.added + edit.added, removed: sum.removed + edit.removed }), { added: 0, removed: 0 })
    const className = row ? 'file-reference-row' : 'file-reference-inline'
    const location = isAbsoluteFileReference(link.path) ? link.path : `${navigation?.workspace.replace(/[/\\]+$/, '')}/${link.path}`
    const title = available ? [description, location].filter(Boolean).join('\n') : [description, 'The subtask did not provide an absolute file path', link.path].filter(Boolean).join('\n')
    const content = row ? <>
      <span className="file-reference-icon" aria-hidden="true"><FileText size={16} /></span>
      <ReferenceName name={name} />
      {totals && <span className="file-stats" aria-label={`${change!.edits.length > 1 ? 'Total changes: ' : ''}${totals.added} lines added, ${totals.removed} lines removed`}><span className="added">+{totals.added}</span><span className="removed">−{totals.removed}</span></span>}
    </> : <><Icon size={14} aria-hidden="true" /><ReferenceName name={name} /></>
    if (!available || !navigation) return <span className={className} title={title} aria-disabled="true">{content}</span>
    const anchor = <a href={href} className={className} aria-label={(row ? [description, name] : [name, description]).filter(Boolean).join(' · ')} onClick={event => { event.preventDefault(); if (matched && turnFiles) turnFiles.openChanges(matched.turnId, matched.file.id); else navigation.openFile(link.path) }}>{content}</a>
    return referenceKind(name) === 'image' ? <ImagePreviewTooltip workspace={navigation.workspace} path={link.path} label={title}>{anchor}</ImagePreviewTooltip> : <FilePathTooltip path={title}>{anchor}</FilePathTooltip>
  }
  if (link.kind === 'file' && navigation?.allowRelativeFiles === false && !isAbsoluteFileReference(link.path)) return <span title="The subtask did not provide an absolute file path">{children}</span>
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
  const [expanded, setExpanded] = useState(false)
  useEffect(() => {
    if (!path || !navigation?.workspace || !window.praxis) return
    let active = true
    void window.praxis.previewFile({ path, workspace: navigation.workspace }).then(file => {
      if (active && file.kind === 'image' && file.dataUrl) setImage({ key: imageKey, url: file.dataUrl })
    }).catch(() => { if (active) setImage(undefined) })
    return () => { active = false }
  }, [path, navigation?.workspace, imageKey])
  const hasImage = Boolean(image && image.key === imageKey)
  const label = alt || fileName(path || (typeof src === 'string' ? src : 'Image'))
  return <><button type="button" className={`content-image ${hasImage ? 'has-image' : ''}`} aria-label={`View image: ${label}`} onClick={() => {
    if (hasImage) setExpanded(true)
    else if (path) navigation?.openFile(path)
    else if (link?.kind === 'external') void window.praxis?.openExternal(link.url).catch(error => navigation?.onError(String(error)))
  }} disabled={!link || link.kind === 'anchor' || link.kind === 'file' && !path}>
    {hasImage && image ? <img src={image.url} alt={label} loading="lazy" onError={() => setImage(undefined)} /> : <><FileImage size={16} /><span>{label}</span></>}
  </button>{expanded && hasImage && image && <ImageLightbox src={image.url} name={label} onClose={() => setExpanded(false)} onOpenPanel={() => { if (path) navigation?.openFile(path) }} />}</>
}

function codeLanguage(node: { children?: unknown[] } | undefined): string {
  const code = node?.children?.find((child): child is { tagName: string; properties?: { className?: unknown } } =>
    typeof child === 'object' && child !== null && (child as { tagName?: string }).tagName === 'code')
  const classes = Array.isArray(code?.properties?.className) ? code.properties.className.map(String) : []
  return classes.find(name => name.startsWith('language-'))?.slice('language-'.length) || ''
}

function CodeBlock({ language, children }: { language: string; children?: React.ReactNode }) {
  const ref = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])
  return <div className="code-block">
    <div className="code-block-header">
      <span className="code-language">{language}</span>
      <button className="code-copy" type="button" aria-label={copied ? 'Copied' : 'Copy code'} title="Copy code" onClick={() => {
        void navigator.clipboard.writeText(ref.current?.innerText || '').then(() => setCopied(true)).catch(() => setCopied(false))
      }}>{copied ? <Check size={14} /> : <Copy size={14} />}<span>{copied ? 'Copied' : 'Copy'}</span></button>
    </div>
    <pre ref={ref}>{children}</pre>
  </div>
}

function MermaidBlock({ source, children }: { source: string; children?: React.ReactNode }) {
  const streaming = useContext(MarkdownStreamingContext)
  const id = `mermaid-${useId().replace(/[^\w-]/g, '')}`
  const [result, setResult] = useState<{ source: string; svg?: string; error?: boolean }>()
  const [code, setCode] = useState(false)
  const [scale, setScale] = useState(1)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (streaming) return
    let active = true
    setScale(1)
    void renderDiagram(source, id).then(svg => { if (active) setResult({ source, svg }) })
      .catch(() => { if (active) setResult({ source, error: true }) })
    return () => { active = false }
  }, [source, streaming, id])
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])
  const diagram = useMemo(() => {
    if (!result?.svg || result.source !== source || streaming) return undefined
    const markup = diagramMarkup(result.svg, id)
    const svg = new DOMParser().parseFromString(markup, 'image/svg+xml').documentElement
    const viewBox = svg.getAttribute('viewBox')?.split(/[ ,]+/).map(Number)
    const width = viewBox?.[2] || Number.parseFloat(svg.getAttribute('width') || '') || 640
    const height = viewBox?.[3] || Number.parseFloat(svg.getAttribute('height') || '') || 320
    return { markup, width, height }
  }, [result, source, streaming, id])
  if (!diagram) return <>{!streaming && result?.source === source && result.error && <div className="mermaid-error" role="status">Unable to render diagram</div>}<CodeBlock language="mermaid">{children}</CodeBlock></>
  return <div className={`code-block mermaid-block ${code ? '' : 'is-diagram'}`} role="group" aria-label={code ? 'Mermaid code' : 'Mermaid diagram'} tabIndex={code ? undefined : 0}>
    <div className="code-block-header"><span className="code-language">mermaid</span><div className="mermaid-toolbar">
      <button type="button" className="code-copy" aria-pressed={!code} onClick={() => setCode(false)}>Diagram</button>
      <button type="button" className="code-copy" aria-pressed={code} onClick={() => setCode(true)}>Code</button>
      <button type="button" className="code-copy" aria-label="Zoom out" title="Zoom out" disabled={code || scale <= .5} onClick={() => setScale(value => Math.max(.5, value - .25))}><Minus size={14} /></button>
      <button type="button" className="code-copy" aria-label="Zoom in" title="Zoom in" disabled={code || scale >= 3} onClick={() => setScale(value => Math.min(3, value + .25))}><Plus size={14} /></button>
      <button type="button" className="code-copy" aria-label="Reset zoom" title="Reset zoom" disabled={code || scale === 1} onClick={() => setScale(1)}><RotateCw size={14} /></button>
      <button type="button" className="code-copy" aria-label={copied ? 'Copied' : 'Copy diagram code'} title="Copy diagram code" onClick={() => {
        void navigator.clipboard.writeText(source).then(() => setCopied(true)).catch(() => setCopied(false))
      }}>{copied ? <Check size={14} /> : <Copy size={14} />}<span>{copied ? 'Copied' : 'Copy'}</span></button>
    </div></div>
    {code ? <pre>{children}</pre> : <div className="mermaid-viewport"><div className="mermaid-size" style={{ width: diagram.width * scale, height: diagram.height * scale }}><div className="mermaid-diagram" style={{ width: diagram.width, height: diagram.height, transform: `scale(${scale})` }} dangerouslySetInnerHTML={{ __html: diagram.markup }} /></div></div>}
  </div>
}

export function normalizeMath(text: string): string {
  let output = ''
  let index = 0
  let fence: { character: string; length: number } | undefined
  while (index < text.length) {
    if (index === 0 || text[index - 1] === '\n') {
      const line = text.slice(index).match(/^[ \t]{0,3}(`{3,}|~{3,})([^\n]*)(?:\n|$)/)
      if (line && (!fence || line[1][0] === fence.character && line[1].length >= fence.length && !line[2].trim())) {
        fence = fence ? undefined : { character: line[1][0], length: line[1].length }
        output += line[0]
        index += line[0].length
        continue
      }
    }
    if (!fence && text[index] === '`') {
      const run = text.slice(index).match(/^`+/)![0]
      const closing = /`+/g
      closing.lastIndex = index + run.length
      let match: RegExpExecArray | null
      let end = index + run.length
      while ((match = closing.exec(text))) if (match[0].length === run.length) { end = match.index + run.length; break }
      output += text.slice(index, end)
      index = end
      continue
    }
    if (!fence && text[index] === '\\') {
      const delimiter = text[index + 1]
      if (delimiter === '[' || delimiter === '(') {
        const close = delimiter === '[' ? '\\]' : '\\)'
        let end = text.indexOf(close, index + 2)
        while (end >= 0) {
          let escapes = 0
          for (let before = end - 1; before >= 0 && text[before] === '\\'; before -= 1) escapes += 1
          if (escapes % 2 === 0) break
          end = text.indexOf(close, end + 2)
        }
        if (end >= 0) {
          const formula = text.slice(index + 2, end)
          output += delimiter === '[' ? `\n$$\n${formula}\n$$\n` : `$$${formula.replace(/\s*\n\s*/g, ' ')}$$`
          index = end + 2
          continue
        }
      }
      output += text.slice(index, index + 2)
      index += 2
      continue
    }
    output += text[index++]
  }
  return output
}

const components: Components = {
  a: ({ href, children, className, node }) => <ContentLink href={href} label={referenceText(node)} row={className === 'file-reference-row'} imageLink={containsImage(node)}>{children}</ContentLink>,
  img: ({ src, alt }) => <ContentImage src={src} alt={alt} />,
  pre: ({ children, node }) => codeLanguage(node) === 'mermaid' ? <MermaidBlock source={referenceText(node)}>{children}</MermaidBlock> : <CodeBlock language={codeLanguage(node)}>{children}</CodeBlock>,
  table: ({ children, node }) => <MarkdownTable node={node}>{children}</MarkdownTable>
}

const highlight: [typeof rehypeHighlight, { detect: false }] = [rehypeHighlight, { detect: false }]
const katex: PluggableList[number] = [rehypeKatex, { throwOnError: false, errorColor: 'var(--error)', strict: 'ignore' }]
const streamingPlugins: PluggableList = [katex, highlight]
const settledPlugins: PluggableList = [katex, highlight, rehypeFileReferences]
const remarkPlugins: PluggableList = [remarkGfm, [remarkMath, { singleDollarTextMath: false }]]
const ParsedMarkdown = memo(Markdown)

export const MarkdownContent = memo(function MarkdownContent({ content, allowRelativeFiles = true, decorateFiles = true, streaming = false, messageActions = false, quoteMessageId }: { content: string; allowRelativeFiles?: boolean; decorateFiles?: boolean; streaming?: boolean; messageActions?: boolean; quoteMessageId?: string }) {
  const inherited = useContext(FileNavigationContext)
  const navigation = useMemo(() => inherited ? { ...inherited, decorateFiles, allowRelativeFiles: allowRelativeFiles && inherited.allowRelativeFiles !== false } : undefined, [inherited, allowRelativeFiles, decorateFiles])
  const text = useMemo(() => normalizeMath(streaming ? remend(content, { linkMode: 'text-only' }) : content), [content, streaming])
  const message = useMemo(() => ({ actions: messageActions, quoteId: quoteMessageId }), [messageActions, quoteMessageId])
  return <FileNavigationContext.Provider value={navigation}><MarkdownStreamingContext.Provider value={streaming}><MarkdownSourceContext.Provider value={text}><MarkdownMessageContext.Provider value={message}><div className="markdown"><ParsedMarkdown remarkPlugins={remarkPlugins} rehypePlugins={decorateFiles && !streaming ? settledPlugins : streamingPlugins} urlTransform={safeContentUrl} components={components}>{text}</ParsedMarkdown></div></MarkdownMessageContext.Provider></MarkdownSourceContext.Provider></MarkdownStreamingContext.Provider></FileNavigationContext.Provider>
})
