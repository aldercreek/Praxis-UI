import type { SVGProps } from 'react'
import artwork from '../../../resources/icons/praxis-outline.json'

type IconName = keyof typeof artwork
type IconProps = Omit<SVGProps<SVGSVGElement>, 'children' | 'dangerouslySetInnerHTML'> & { size?: number }

// Original, locally bundled artwork. Bodies contain SVG geometry only; message
// content never reaches this renderer. Each drawing owns its stroke and fill.
function icon(name: IconName, filled?: IconName) {
  return function PraxisIcon({ size = 16, className = '', fill, ...props }: IconProps) {
    const selected = filled && fill === 'currentColor' ? filled : name
    return <svg width={size} height={size} viewBox={artwork[selected].viewBox}
      aria-hidden="true" focusable="false" {...props} className={`ui-icon ${className}`} data-icon={selected}
      dangerouslySetInnerHTML={{ __html: artwork[selected].body }} />
  }
}

export const ArrowDown = icon('arrowDown')
export const ArrowUp = icon('arrowUp')
export const ArrowRight = icon('arrowRight')
export const ArrowUpRight = icon('arrowUpRight')
export const ChevronDown = icon('chevronDown')
export const ChevronRight = icon('chevronRight')
export const ChevronLeft = icon('chevronLeft')
export const CircleAlert = icon('alertCircle')
export const Folder = icon('folder')
export const FolderOpen = icon('folderOpen')
export const FileDiff = icon('file')
export const LoaderCircle = icon('loader')
export const ShieldCheck = icon('shield')
export const Minus = icon('minus')
export const PanelLeft = icon('panelLeft')
export const Plus = icon('plus')
export const Quote = icon('quote')
export const Square = icon('square')
export const Stop = icon('stop')
export const X = icon('close')
export const ListChecks = icon('listChecks')
export const Check = icon('check')
export const Circle = icon('circle')
export const Clock3 = icon('clock')
export const CircleDashed = icon('circleDashed')
export const CircleSlash = icon('circleSlash')
export const Plug = icon('plug')
export const Blocks = icon('tools')
export const Link2 = icon('link')
export const Bookmark = icon('bookmark', 'bookmarkFilled')
export const Copy = icon('copy')
export const Trash2 = icon('trash')
export const Ellipsis = icon('ellipsis')
export const FileText = icon('file')
export const RotateCw = icon('refresh')
export const RefreshCw = icon('refresh')
export const Archive = icon('archive')
export const FileCode2 = icon('fileCode')
export const FileImage = icon('image')
export const Image = icon('image')
export const FileSpreadsheet = icon('spreadsheet')
export const Presentation = icon('presentation')
export const GripVertical = icon('grip')
export const Navigation2 = icon('send')
export const PencilLine = icon('edit')
export const Pencil = icon('edit')
export const Pin = icon('pin')
export const Search = icon('search')
export const Settings2 = icon('settings')
export const Share2 = icon('share')
export const GitBranch = icon('agents')
export const Terminal = icon('terminal')
export const CheckCircle2 = icon('checkCircle')
