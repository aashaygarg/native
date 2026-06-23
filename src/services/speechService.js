// Voice input (Phase 9):
//   mic -> ffmpeg (temp WAV) -> whisper large-v3-turbo -> text
//
// Voice only fills the input box; the user still edits and submits. Local only:
// ffmpeg records the microphone, the local whisper CLI transcribes. No cloud,
// no streaming, single-shot. (Ollama has no speech-to-text, so it is not used
// for this.) Plain functions — no classes, managers, providers, or buses.

const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const TMP = os.tmpdir()
const WAV = path.join(TMP, 'native-voice.wav')
const TXT = path.join(TMP, 'native-voice.txt')

// macOS default audio input device (override with NATIVE_AUDIO_DEVICE, e.g. ':1').
const AUDIO_DEVICE = process.env.NATIVE_AUDIO_DEVICE || ':default'
const MODEL = process.env.NATIVE_WHISPER_MODEL || 'large-v3-turbo'

let recProc = null

function startRecording() {
  if (recProc) return false
  try { fs.unlinkSync(WAV) } catch (e) {}
  try {
    recProc = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'avfoundation', '-i', AUDIO_DEVICE,
      '-ac', '1', '-ar', '16000', WAV,
    ], { stdio: ['pipe', 'ignore', 'ignore'] })
  } catch (e) {
    recProc = null
    return false
  }
  recProc.on('error', () => { recProc = null })
  return true
}

// Stop ffmpeg cleanly so the WAV header is finalized.
function stopRecording() {
  return new Promise((resolve) => {
    const p = recProc
    if (!p) { resolve(false); return }
    recProc = null
    let settled = false
    const finish = () => { if (!settled) { settled = true; resolve(fs.existsSync(WAV)) } }
    p.on('close', finish)
    try { p.stdin.write('q\n') } catch (e) { try { p.kill('SIGINT') } catch (e2) {} }
    setTimeout(() => { try { p.kill('SIGKILL') } catch (e) {} finish() }, 2000)
  })
}

// Single-shot transcription via the local whisper CLI. Returns the text and
// deletes the temporary files.
function transcribe() {
  return new Promise((resolve) => {
    if (!fs.existsSync(WAV)) { resolve(''); return }
    let proc
    try {
      proc = spawn('whisper', [
        WAV,
        '--model', MODEL,
        '--language', 'en',
        '--task', 'transcribe',
        '--output_format', 'txt',
        '--output_dir', TMP,
        '--fp16', 'False',
        '--verbose', 'False',
      ], { stdio: 'ignore' })
    } catch (e) {
      resolve('')
      return
    }
    const done = () => {
      let text = ''
      try { text = fs.readFileSync(TXT, 'utf8').trim() } catch (e) {}
      try { fs.unlinkSync(WAV) } catch (e) {}
      try { fs.unlinkSync(TXT) } catch (e) {}
      resolve(text)
    }
    proc.on('close', done)
    proc.on('error', () => resolve(''))
  })
}

module.exports = { startRecording, stopRecording, transcribe }
