const readline = require('node:readline')

const input = readline.createInterface({ input: process.stdin })
const timers = new Set()
const send = frame => process.stdout.write(`${JSON.stringify(frame)}\n`)
const reply = (request, result) => send({ id: request.id, result })

function later(callback, delay) {
  const timer = setTimeout(() => {
    timers.delete(timer)
    callback()
  }, delay)
  timers.add(timer)
}

function close() {
  for (const timer of timers) clearTimeout(timer)
  timers.clear()
  input.close()
  process.stdin.pause()
  process.stdout.end(() => process.exit(0))
}

input.on('line', line => {
  const request = JSON.parse(line)
  const params = request.params || {}
  switch (request.method) {
    case 'initialize':
      reply(request, {
        protocol_version: Number(process.env.FIXTURE_PROTOCOL_VERSION || 1),
        model: 'fixture-model',
        configured: true
      })
      break
    case 'shutdown':
      reply(request, { ok: true })
      close()
      break
    case 'fixture.echo':
      later(() => reply(request, { value: params.value }), params.delay || 0)
      break
    case 'fixture.chunked': {
      const bytes = Buffer.from(`${JSON.stringify({ id: request.id, result: { value: params.value } })}\n`)
      let offset = 0
      // Single-byte writes intentionally split Chinese and emoji UTF-8 sequences.
      const writeByte = () => {
        process.stdout.write(bytes.subarray(offset, ++offset))
        if (offset < bytes.length) later(writeByte, 1)
      }
      writeByte()
      break
    }
    case 'fixture.events':
      for (const event of params.events) send(event)
      reply(request, { emitted: params.events.length })
      break
    case 'fixture.error':
      send({ id: request.id, error: { code: 'SESSION_BUSY', message: '此会话已有任务正在执行' } })
      break
    case 'fixture.malformed':
      process.stdout.write('unexpected non-JSON backend output\n')
      break
    case 'fixture.exit':
      later(() => process.exit(23), 10)
      break
    case 'fixture.never':
      break
    default:
      send({ id: request.id, error: { code: 'UNKNOWN_METHOD', message: request.method } })
  }
})

input.on('close', () => {
  for (const timer of timers) clearTimeout(timer)
})
