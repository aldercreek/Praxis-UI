import type { Element, ElementContent, Root, RootContent } from 'hast'
import { contentLink, fileName } from './fileLinks'

export function referenceText(node?: Element): string {
  const text = (node: ElementContent): string => node.type === 'text' ? node.value : node.type === 'element' ? node.children.map(text).join('') : ''
  return node?.children.map(text).join('').trim() || ''
}

export function containsImage(node?: Element): boolean {
  return Boolean(node && (node.tagName === 'img' || node.children.some(child => child.type === 'element' && containsImage(child))))
}

export function referenceName(path: string): string {
  let value = path
  if (/^file:/i.test(value)) {
    try { value = new URL(value).pathname } catch { /* Keep a malformed reference readable. */ }
  }
  try { value = decodeURIComponent(value) } catch { /* A filename may contain a literal percent sign. */ }
  return fileName(value)
}

export function referenceKind(name: string): 'code' | 'image' | 'sheet' | 'slides' | 'archive' | 'document' {
  const extension = name.replace(/:\d+(?::\d+)?$/, '').split('#')[0].split('.').at(-1)?.toLowerCase() || ''
  if (/^(?:ts|tsx|js|jsx|mjs|cjs|json|jsonc|css|scss|html|xml|py|rb|go|rs|java|kt|c|cpp|h|cs|sh|sql|yml|yaml|toml)$/.test(extension)) return 'code'
  if (/^(?:png|jpg|jpeg|gif|webp|avif|bmp|svg|ico|tif|tiff)$/.test(extension)) return 'image'
  if (/^(?:xls|xlsx|csv|tsv|ods)$/.test(extension)) return 'sheet'
  if (/^(?:ppt|pptx|odp)$/.test(extension)) return 'slides'
  if (/^(?:zip|tar|gz|7z|rar)$/.test(extension)) return 'archive'
  return 'document'
}

function fileLinksOnly(nodes: ElementContent[]): Element[] | undefined {
  const links: Element[] = []
  for (const node of nodes) {
    if (node.type === 'text' && /^[\s·•|、,，;；]*$/.test(node.value)) continue
    if (node.type === 'element' && node.tagName === 'br') continue
    if (node.type !== 'element' || node.tagName !== 'a' || typeof node.properties.href !== 'string'
      || contentLink(node.properties.href)?.kind !== 'file' || containsImage(node)) return
    links.push(node)
  }
  return links.length ? links : undefined
}

function fileBlock(node: RootContent): Element[] | undefined {
  if (node.type !== 'element') return
  if (node.tagName === 'p') return fileLinksOnly(node.children)
  // Numbered steps, checklists and lists containing prose keep their semantics.
  if (node.tagName !== 'ul') return
  const links: Element[] = []
  for (const item of node.children) {
    if (item.type === 'text' && !item.value.trim()) continue
    if (item.type !== 'element' || item.tagName !== 'li') return
    const children = item.children.filter(child => child.type !== 'text' || child.value.trim())
    const contents = children.length === 1 && children[0].type === 'element' && children[0].tagName === 'p' ? children[0].children : children
    const itemLinks = fileLinksOnly(contents)
    if (itemLinks?.length !== 1) return
    links.push(itemLinks[0])
  }
  return links.length ? links : undefined
}

function element(tagName: string, className: string, children: ElementContent[], properties: Element['properties'] = {}): Element {
  return { type: 'element', tagName, properties: { className: [className], ...properties }, children }
}

function fileGroup(links: Element[]): Element {
  return element('section', 'file-reference-group', [
    element('div', 'file-reference-heading', [
      element('span', 'file-reference-title', [{ type: 'text', value: '相关文件' }]),
      element('span', 'file-reference-count', [{ type: 'text', value: String(links.length) }])
    ]),
    element('ul', 'file-reference-list', links.map(link => element('li', 'file-reference-item', [{
      ...link, properties: { ...link.properties, className: ['file-reference-row'] }
    }])))
  ], { ariaLabel: '相关文件' })
}

// Work on parsed Markdown, so reference links, escapes and labels stay intact.
// Only top-level runs made entirely of local file references become file lists.
export function rehypeFileReferences() {
  return (root: Root) => {
    const output: RootContent[] = []
    for (let index = 0; index < root.children.length;) {
      const first = fileBlock(root.children[index])
      if (!first) { output.push(root.children[index++]); continue }
      const links = [...first]
      let end = index + 1
      while (end < root.children.length) {
        const next = root.children[end]
        if (next.type === 'text' && !next.value.trim()) { end += 1; continue }
        const block = fileBlock(next)
        if (!block) break
        links.push(...block)
        end += 1
      }
      output.push(...(links.length > 1 ? [fileGroup(links)] : root.children.slice(index, end)))
      index = end
    }
    root.children = output
  }
}
