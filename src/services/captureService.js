const { desktopCapturer, screen } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')

// Capture the primary display, save it as a PNG in the temp directory, and
// return the saved file path.
async function captureScreen() {
  const display = screen.getPrimaryDisplay()
  const { width, height } = display.size
  const scale = display.scaleFactor

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(width * scale),
      height: Math.round(height * scale),
    },
  })

  const primary = sources[0]
  const pngBuffer = primary.thumbnail.toPNG()

  const filePath = path.join(os.tmpdir(), `native-capture-${Date.now()}.png`)
  fs.writeFileSync(filePath, pngBuffer)

  return filePath
}

module.exports = { captureScreen }
