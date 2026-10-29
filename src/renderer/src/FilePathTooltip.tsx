import type { ReactNode } from 'react'
import { Tooltip } from './Tooltip'

export function FilePathTooltip({ path, children }: { path: string; children: ReactNode }) {
  return <Tooltip content={path} className="file-path-tooltip">{children}</Tooltip>
}
