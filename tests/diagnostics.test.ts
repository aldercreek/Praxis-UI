import { Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { createDiagnosticWriter } from '../src/main/diagnostics'

describe('desktop diagnostic output', () => {
  it('forwards diagnostics while the destination is usable', () => {
    const chunks: string[] = []
    const stream = new Writable({ write(chunk, _encoding, callback) { chunks.push(chunk.toString()); callback() } })
    const write = createDiagnosticWriter(stream)

    write('[Praxis] 你好\n')
    write('another diagnostic\n')
    expect(chunks).toEqual(['[Praxis] 你好\n', 'another diagnostic\n'])
    stream.end()
  })

  it('contains an asynchronous broken pipe and stops writing to that destination', async () => {
    let writes = 0
    const stream = new Writable({ write(_chunk, _encoding, callback) {
      writes += 1
      setImmediate(() => callback(Object.assign(new Error('broken pipe'), { code: 'EPIPE' })))
    } })
    const closed = new Promise<void>(resolve => stream.once('close', resolve))
    const write = createDiagnosticWriter(stream)

    write('diagnostic after the launcher exited')
    await closed
    write('later diagnostic')
    expect(writes).toBe(1)
  })

  it('also contains synchronous stream failures', () => {
    let writes = 0
    const stream = new Writable({ write() {
      writes += 1
      throw Object.assign(new Error('broken pipe'), { code: 'EPIPE' })
    } })
    const write = createDiagnosticWriter(stream)

    expect(() => write('first diagnostic')).not.toThrow()
    expect(() => write('later diagnostic')).not.toThrow()
    expect(writes).toBe(1)
    stream.destroy()
  })
})
