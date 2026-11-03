import type { FilePreview } from '../../shared/protocol'

export function createImagePreviewCache(limit = 30) {
  const images = new Map<string, string>()
  const pending = new Map<string, Promise<string>>()
  return async (workspace: string, path: string, load: () => Promise<FilePreview>): Promise<string> => {
    const key = JSON.stringify([workspace, path])
    const cached = images.get(key)
    if (cached) return cached
    const running = pending.get(key)
    if (running) return running
    const result = load().then(file => {
      if (file.kind !== 'image' || !file.dataUrl) throw new Error('Image preview unavailable')
      images.set(key, file.dataUrl)
      if (images.size > limit) images.delete(images.keys().next().value!)
      return file.dataUrl
    })
    pending.set(key, result)
    try { return await result } finally { pending.delete(key) }
  }
}

export const loadImagePreview = createImagePreviewCache()
