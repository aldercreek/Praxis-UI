export function stripAnsi(text: string): string {
  return text.replace(/(?:\x1b\]|\x9d)[\s\S]*?(?:\x07|\x1b\\|\x9c|$)/g, '')
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*(?:[@-~]|$)/g, '')
    .replace(/\x1b[ -/]*[@-~]/g, '')
    .replaceAll('\r\n', '\n').split('\n').map(line => line.slice(line.lastIndexOf('\r') + 1)).join('\n')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '')
}
