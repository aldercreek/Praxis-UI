export const clampImageZoom = (value: number): number => Math.max(.5, Math.min(4, value))
export const fitImageScale = (width: number, height: number, viewportWidth: number, viewportHeight: number): number => Math.min(1, viewportWidth * .9 / Math.max(1, width), Math.min(viewportHeight * .9, viewportHeight - 72) / Math.max(1, height))
export function imagePan(x: number, y: number, width: number, height: number, viewportWidth: number, viewportHeight: number) {
  const maxX = Math.max(0, (width - viewportWidth) / 2)
  const maxY = Math.max(0, (height - viewportHeight) / 2)
  return { x: Math.max(-maxX, Math.min(maxX, x)), y: Math.max(-maxY, Math.min(maxY, y)) }
}
