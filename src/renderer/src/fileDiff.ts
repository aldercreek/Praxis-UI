export interface DiffLine {
  kind: 'add' | 'remove' | 'context'
  content: string
  number?: number
}

/** Convert unified diff hunks into display rows, keeping old numbers on removals. */
export function fileDiffLines(diff: string): DiffLine[] {
  const result: DiffLine[] = []
  let oldLine = 0
  let newLine = 0
  let oldRemaining = 0
  let newRemaining = 0
  const lines = diff.replaceAll('\r\n', '\n').split('\n')
  if (lines.at(-1) === '') lines.pop()
  for (const line of lines) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (hunk) {
      oldLine = Number(hunk[1]); newLine = Number(hunk[3])
      oldRemaining = Number(hunk[2] ?? 1); newRemaining = Number(hunk[4] ?? 1)
      continue
    }
    if (line.startsWith('\\ No newline at end of file')) continue
    const inHunk = oldRemaining > 0 || newRemaining > 0
    if (!inHunk && /^(?:--- |\+\+\+ |diff --git |index |new file mode |deleted file mode |old mode |new mode |similarity index |rename from |rename to |copy from |copy to |@@)/.test(line)) continue
    if (line.startsWith('+')) {
      result.push({ kind: 'add', content: line.slice(1), number: inHunk ? newLine : undefined })
      if (inHunk) { newLine += 1; newRemaining -= 1 }
    } else if (line.startsWith('-')) {
      result.push({ kind: 'remove', content: line.slice(1), number: inHunk ? oldLine : undefined })
      if (inHunk) { oldLine += 1; oldRemaining -= 1 }
    } else {
      result.push({ kind: 'context', content: line.startsWith(' ') ? line.slice(1) : line, number: inHunk ? newLine : undefined })
      if (inHunk) { oldLine += 1; newLine += 1; oldRemaining -= 1; newRemaining -= 1 }
    }
  }
  return result
}
