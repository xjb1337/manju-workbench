const { spawnSync } = require('node:child_process')
const { writeFileSync } = require('node:fs')
const path = require('node:path')

const sizes = [16, 24, 32, 48, 64, 128, 256]

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#764be0" />
      <stop offset="55%" stop-color="#5d35b8" />
      <stop offset="100%" stop-color="#42208f" />
    </linearGradient>
    <linearGradient id="slate" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffffff" />
      <stop offset="100%" stop-color="#ebe4fa" />
    </linearGradient>
    <filter id="drop" x="-15%" y="-15%" width="130%" height="130%">
      <feDropShadow dx="0" dy="6" stdDeviation="6" flood-color="#1d0d45" flood-opacity="0.32" />
    </filter>
  </defs>

  <rect x="12" y="12" width="232" height="232" rx="54" fill="url(#bg)" />
  <rect x="14" y="14" width="228" height="228" rx="52" fill="none" stroke="#ffffff" stroke-opacity="0.22" stroke-width="4" />

  <g filter="url(#drop)">
    <g transform="translate(54, 72) rotate(-13 0 24)">
      <rect x="0" y="0" width="144" height="28" rx="7" fill="url(#slate)" />
      <path d="M24 0 L42 0 L30 28 L12 28 Z" fill="#5d35b8" />
      <path d="M64 0 L82 0 L70 28 L52 28 Z" fill="#5d35b8" />
      <path d="M104 0 L122 0 L110 28 L92 28 Z" fill="#5d35b8" />
    </g>

    <rect x="54" y="96" width="148" height="104" rx="14" fill="url(#slate)" />

    <path d="M54 110 C54 102 60 96 68 96 L188 96 C196 96 202 102 202 110 L202 118 L54 118 Z" fill="#dfd4f7" />
    <path d="M74 96 L92 96 L82 118 L64 118 Z" fill="#5d35b8" />
    <path d="M114 96 L132 96 L122 118 L104 118 Z" fill="#5d35b8" />
    <path d="M154 96 L172 96 L162 118 L144 118 Z" fill="#5d35b8" />

    <path d="M112 135 C112 132 115.5 130 118 131.6 L154 154 C156.5 155.5 156.5 159.5 154 161 L118 183.4 C115.5 185 112 183 112 180 Z" fill="#5d35b8" />
  </g>
</svg>`

function encodeDibEntry(rgba, width, height) {
  const rowStride = width * 4
  const andRowStride = Math.ceil(width / 32) * 4
  const headerSize = 40
  const pixelBytes = rowStride * height
  const andBytes = andRowStride * height
  const buf = Buffer.alloc(headerSize + pixelBytes + andBytes)

  buf.writeUInt32LE(headerSize, 0)
  buf.writeInt32LE(width, 4)
  buf.writeInt32LE(height * 2, 8)
  buf.writeUInt16LE(1, 12)
  buf.writeUInt16LE(32, 14)
  buf.writeUInt32LE(0, 16)
  buf.writeUInt32LE(pixelBytes + andBytes, 20)

  for (let y = 0; y < height; y++) {
    const srcY = height - 1 - y
    for (let x = 0; x < width; x++) {
      const srcIdx = (srcY * width + x) * 4
      const dstIdx = headerSize + y * rowStride + x * 4
      buf[dstIdx] = rgba[srcIdx + 2]
      buf[dstIdx + 1] = rgba[srcIdx + 1]
      buf[dstIdx + 2] = rgba[srcIdx]
      buf[dstIdx + 3] = rgba[srcIdx + 3]

      if (rgba[srcIdx + 3] === 0) {
        const andByteIdx = headerSize + pixelBytes + y * andRowStride + (x >> 3)
        buf[andByteIdx] |= 0x80 >> (x & 7)
      }
    }
  }
  return buf
}

function buildIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)

  const dir = Buffer.alloc(entries.length * 16)
  let offset = 6 + dir.length
  const payloads = []

  entries.forEach((entry, index) => {
    const base = index * 16
    dir[base] = entry.size === 256 ? 0 : entry.size
    dir[base + 1] = entry.size === 256 ? 0 : entry.size
    dir[base + 2] = 0
    dir[base + 3] = 0
    dir.writeUInt16LE(1, base + 4)
    dir.writeUInt16LE(32, base + 6)
    dir.writeUInt32LE(entry.data.length, base + 8)
    dir.writeUInt32LE(offset, base + 12)
    offset += entry.data.length
    payloads.push(entry.data)
  })

  return Buffer.concat([header, dir, ...payloads])
}

if (!process.versions.electron) {
  const electronBinary = require('electron')
  const result = spawnSync(electronBinary, [__filename], { stdio: 'inherit', shell: false })
  process.exit(result.status ?? 1)
} else {
  const { app, BrowserWindow } = require('electron')
  app.whenReady().then(async () => {
    const win = new BrowserWindow({
      show: false,
      width: 256,
      height: 256,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    })
    try {
      await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><html><body></body></html>'))
      const rendered = await win.webContents.executeJavaScript(`(async () => {
        const svgText = ${JSON.stringify(svg)};
        const sizes = ${JSON.stringify(sizes)};
        const dataUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgText);
        const img = new Image();
        await new Promise((resolve, reject) => {
          img.onload = resolve;
          img.onerror = reject;
          img.src = dataUrl;
        });
        const results = [];
        for (const s of sizes) {
          const canvas = document.createElement('canvas');
          canvas.width = s;
          canvas.height = s;
          const ctx = canvas.getContext('2d');
          ctx.clearRect(0, 0, s, s);
          ctx.drawImage(img, 0, 0, s, s);
          if (s === 256) {
            const pngUrl = canvas.toDataURL('image/png');
            results.push({ size: s, pngBase64: pngUrl.split(',')[1] });
          } else {
            results.push({ size: s, rgba: Array.from(ctx.getImageData(0, 0, s, s).data) });
          }
        }
        return results;
      })()`)

      const entries = []
      let png256 = null
      for (const item of rendered) {
        if (item.size === 256) {
          png256 = Buffer.from(item.pngBase64, 'base64')
          entries.push({ size: 256, data: png256 })
        } else {
          entries.push({ size: item.size, data: encodeDibEntry(Uint8Array.from(item.rgba), item.size, item.size) })
        }
      }

      const resourcesDir = path.join(__dirname, '..', 'resources')
      writeFileSync(path.join(resourcesDir, 'icon.png'), png256)
      writeFileSync(path.join(resourcesDir, 'icon.ico'), buildIco(entries))
      console.log('Generated resources/icon.png and resources/icon.ico')
    } finally {
      win.destroy()
      app.quit()
    }
  }).catch(err => {
    console.error(err)
    app.exit(1)
  })
}
