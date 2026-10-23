// Render the same vector mark used in the UI into native application icons.
const { app, BrowserWindow, nativeImage } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

app.whenReady().then(async () => {
  const directory = join(__dirname, '..', 'resources', 'brand')
  const mark = readFileSync(join(directory, 'praxis-mark.svg'), 'utf8')
  const glyph = mark.replace(/<svg[^>]*>/, '').replace('</svg>', '').trim()
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 64 64"><rect x="2" y="2" width="60" height="60" rx="14" fill="#222222"/><g transform="translate(8 8) scale(1.5)" fill="#ffffff">${glyph}</g></svg>`
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } })
  try {
    await window.loadURL('data:text/html,<meta charset="UTF-8">')
    const data = await window.webContents.executeJavaScript(`(async () => {
      const image = new Image()
      image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(${JSON.stringify(svg)})
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 512
      canvas.getContext('2d').drawImage(image, 0, 0, 512, 512)
      return canvas.toDataURL('image/png').split(',')[1]
    })()`)
    const png = Buffer.from(data, 'base64')
    const source = nativeImage.createFromBuffer(png)
    const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
    const images = sizes.map(size => source.resize({ width: size, height: size, quality: 'best' }).toPNG())
    // Windows ICO supports PNG entries, retaining transparency at every native size.
    const header = Buffer.alloc(6 + sizes.length * 16)
    header.writeUInt16LE(1, 2)
    header.writeUInt16LE(sizes.length, 4)
    let offset = header.length
    sizes.forEach((size, index) => {
      const entry = 6 + index * 16
      header[entry] = header[entry + 1] = size === 256 ? 0 : size
      header.writeUInt16LE(1, entry + 4)
      header.writeUInt16LE(32, entry + 6)
      header.writeUInt32LE(images[index].length, entry + 8)
      header.writeUInt32LE(offset, entry + 12)
      offset += images[index].length
    })
    writeFileSync(join(directory, 'icon.svg'), svg + '\n')
    writeFileSync(join(directory, 'icon.png'), png)
    writeFileSync(join(directory, 'icon.ico'), Buffer.concat([header, ...images]))
    console.log('Generated Praxis icons: PNG 512px; ICO 16–256px.')
  } finally {
    window.destroy()
  }
  app.quit()
}).catch(error => { console.error(error); app.exit(1) })
