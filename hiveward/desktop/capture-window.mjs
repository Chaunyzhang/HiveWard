async function captureSurface(webContents, acquireDebugger) {
  try {
    return (await webContents.capturePage()).toDataURL()
  } catch {
    const lease = acquireDebugger(webContents)
    try {
      const { data } = await webContents.debugger.sendCommand('Page.captureScreenshot', {
        format: 'png'
      })
      return `data:image/png;base64,${data}`
    } finally {
      lease.release()
    }
  }
}

// Electron captures each WebContents separately, so compose the visible native child surfaces.
export async function captureWindow(window, tabs, acquireDebugger) {
  const background = await captureSurface(window.webContents, acquireDebugger)
  const layers = []
  const active = tabs?.bounds && tabs.tabs.get(tabs.active)
  if (active) {
    layers.push({
      rect: tabs.bounds,
      image: await captureSurface(active.view.webContents, acquireDebugger)
    })
  }
  if (!layers.length) {
    return Buffer.from(background.split(',')[1], 'base64')
  }
  const [width] = window.getContentSize()
  const payload = { background, layers, width }
  const result = await window.webContents.executeJavaScript(`(async () => {
    const data = ${JSON.stringify(payload)};
    const load = async src => { const img = new Image(); img.src = src; await img.decode(); return img; };
    const base = await load(data.background), canvas = document.createElement('canvas');
    canvas.width = base.naturalWidth; canvas.height = base.naturalHeight;
    const ctx = canvas.getContext('2d'); ctx.drawImage(base, 0, 0);
    const scale = canvas.width / data.width;
    for (const layer of data.layers) {
      const img = await load(layer.image), r = layer.rect;
      ctx.drawImage(img, r.x * scale, r.y * scale, r.width * scale, r.height * scale);
    }
    return canvas.toDataURL('image/png');
  })()`)
  return Buffer.from(result.split(',')[1], 'base64')
}
