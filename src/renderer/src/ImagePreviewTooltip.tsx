import { useEffect, useState, type ReactNode } from 'react'
import { Tooltip } from './Tooltip'
import { loadImagePreview } from './imagePreview'
import './imagePreview.css'

function Preview({ workspace, path, label }: { workspace: string; path: string; label: string }) {
  const [result, setResult] = useState<{ url?: string; failed?: boolean }>({})
  useEffect(() => {
    let active = true
    void loadImagePreview(workspace, path, () => window.praxis.previewFile({ workspace, path })).then(url => { if (active) setResult({ url }) })
      .catch(() => { if (active) setResult({ failed: true }) })
    return () => { active = false }
  }, [workspace, path])
  return <>{result.url ? <img src={result.url} alt="Image preview" onError={() => setResult({ failed: true })} /> : !result.failed && <span className="image-preview-skeleton" role="status" aria-label="Loading image preview" />}<span>{label}</span></>
}

export function ImagePreviewTooltip({ workspace, path, label, children }: { workspace: string; path: string; label: string; children: ReactNode }) {
  return <Tooltip content={<Preview key={`${workspace}:${path}`} workspace={workspace} path={path} label={label} />} className="file-path-tooltip image-preview-tooltip">{children}</Tooltip>
}
