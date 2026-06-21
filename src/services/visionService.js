const { nativeImage } = require('electron')

const OLLAMA_URL = 'http://localhost:11434/api/generate'
const MODEL = 'qwen3-vl:30b'
const PROMPT =
  'Read this screenshot and output only the text that is visible in it, ' +
  'exactly as written. Do not solve, answer, explain, summarize, or add ' +
  'anything that is not visible.'

// Send the screenshot to qwen3-vl via Ollama and return the visible text.
// The capture is downscaled and the context kept small so the 30B vision model
// stays within Metal's GPU memory limits — a full-resolution Retina image with
// a 32k context crashes the Ollama runner.
async function understand(imagePath) {
  const image = nativeImage.createFromPath(imagePath).resize({ width: 1280 })
  const imageBase64 = image.toPNG().toString('base64')

  const payload = JSON.stringify({
    model: MODEL,
    prompt: PROMPT,
    images: [imageBase64],
    stream: false,
    options: { num_ctx: 4096 },
  })

  // The 30B vision model occasionally crashes Ollama's Metal runner, which
  // drops the connection. The runner auto-restarts, so retry once after a short
  // pause before surfacing an error.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await fetch(OLLAMA_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      })

      if (!response.ok) {
        const body = await response.text()
        throw new Error(`Ollama request failed: ${response.status} ${body}`)
      }

      const data = await response.json()
      return { text: data.response.trim() }
    } catch (err) {
      if (attempt === 2) throw err
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
  }
}

module.exports = { understand }
