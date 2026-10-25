export type ContentLink = { kind: 'external'; url: string } | { kind: 'file'; path: string } | { kind: 'anchor'; id: string }

export function contentLink(value: string, baseFile?: string): ContentLink | undefined {
  const href = value.trim()
  if (!href || /[\u0000-\u001f]/.test(href)) return
  if (/^https?:\/\//i.test(href)) return { kind: 'external', url: href }
  if (href.startsWith('#')) return { kind: 'anchor', id: href.slice(1) }
  if (/^[/\\]{2}/.test(href)) return
  const drive = /^\/?[a-z]:[/\\]/i.test(href)
  const fileLine = /^[^:]+\.[a-z\d]+:\d+(?::\d+)?$/i.test(href)
  if (!drive && !fileLine && /^[a-z][a-z\d+.-]*:/i.test(href) && !/^file:/i.test(href)) return
  let path = href
  // Markdown preview links are relative to that document, not the project root.
  if (baseFile && !drive && !/^file:/i.test(path) && !path.startsWith('/')) {
    const parent = baseFile.replaceAll('\\', '/').replace(/\/[^/]*$/, '')
    path = `${parent}/${path}`
  }
  return { kind: 'file', path }
}

export const safeContentUrl = (url: string): string => contentLink(url) ? url : ''

export function isAbsoluteFileReference(path: string): boolean {
  return /^file:/i.test(path) || /^\/?[a-z]:[/\\]/i.test(path) || path.startsWith('/')
}

export function fileName(path: string): string {
  return path.replaceAll('\\', '/').split('/').pop() || path
}
