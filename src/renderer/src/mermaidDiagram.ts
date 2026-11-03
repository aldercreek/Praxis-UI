const diagrams = new Map<string, string>()
const pending = new Map<string, Promise<string>>()
let library: Promise<typeof import('mermaid')['default']> | undefined

function loadMermaid() {
  if (!library) library = (async () => {
    const { default: mermaid } = await import('mermaid')
    const styles = getComputedStyle(document.documentElement)
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const context = canvas.getContext('2d')
    const color = (name: string, fallback: string) => {
      const value = styles.getPropertyValue(name).trim() || fallback
      if (!context) return value
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, 1, 1)
      context.fillStyle = value
      context.fillRect(0, 0, 1, 1)
      const [r, g, b] = context.getImageData(0, 0, 1, 1).data
      return `rgb(${r}, ${g}, ${b})`
    }
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'base',
      fontFamily: styles.getPropertyValue('--font-ui').trim() || 'sans-serif',
      themeVariables: {
        primaryColor: color('--subtle', '#fafafa'), primaryTextColor: color('--ink', '#171717'),
        primaryBorderColor: color('--border', '#e6e6e6'), lineColor: color('--muted', '#6b6b6b'),
        secondaryColor: color('--sidebar', '#f7f7f7'), tertiaryColor: color('--surface', '#ffffff'),
        background: color('--surface', '#ffffff'), mainBkg: color('--subtle', '#fafafa'),
        textColor: color('--ink', '#171717'), nodeBorder: color('--border', '#e6e6e6'),
        clusterBkg: color('--surface', '#ffffff'), clusterBorder: color('--border', '#e6e6e6'),
        edgeLabelBackground: color('--surface', '#ffffff')
      }
    })
    return mermaid
  })().catch(error => { library = undefined; throw error })
  return library
}

export async function renderDiagram(source: string, id: string): Promise<string> {
  const cached = diagrams.get(source)
  if (cached !== undefined) return cached
  const running = pending.get(source)
  if (running) return running
  const result = (async () => {
    const mermaid = await loadMermaid()
    const container = document.createElement('div')
    container.style.cssText = 'position:fixed;left:0;top:0;visibility:hidden;pointer-events:none'
    document.body.append(container)
    try {
      const { svg } = await mermaid.render(id, source, container)
      diagrams.set(source, svg)
      if (diagrams.size > 50) diagrams.delete(diagrams.keys().next().value!)
      return svg
    } finally { container.remove() }
  })()
  pending.set(source, result)
  try { return await result } finally { pending.delete(source) }
}

export function diagramMarkup(svg: string, prefix: string): string {
  const document = new DOMParser().parseFromString(svg, 'image/svg+xml')
  const ids = new Map([...document.querySelectorAll('[id]')].map((element, index) => [element.id, `${prefix}-${index}`]))
  const references = (value: string) => value.replace(/#([\w:.-]+)/g, (match, id: string) => ids.has(id) ? `#${ids.get(id)}` : match)
  for (const element of document.querySelectorAll('*')) {
    for (const attribute of [...element.attributes]) {
      if (attribute.name === 'id') element.setAttribute('id', ids.get(attribute.value)!)
      else if (['aria-labelledby', 'aria-describedby'].includes(attribute.name)) element.setAttribute(attribute.name, attribute.value.split(' ').map(id => ids.get(id) || id).join(' '))
      else if (attribute.value.includes('#')) element.setAttribute(attribute.name, references(attribute.value))
    }
    if (element.tagName === 'style') element.textContent = references(element.textContent || '')
  }
  return new XMLSerializer().serializeToString(document.documentElement)
}
