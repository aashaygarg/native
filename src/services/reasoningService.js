// Reasoning (Phase 6.5):
//   OCR text + user question -> qwen3-coder stream -> answer
//
// The perception engine hands us the text it read from the intent window. This
// service works out what the user implicitly needs from that text and answers
// it: an approach + code for a coding problem, a diagnosis + fix for an error,
// a summary for an article, a root cause + commands for terminal output.
//
// Deliberately minimal: one plain prompt, one Ollama call, no retries, no
// repair loops, no templates, no classes, no abstractions.

const OLLAMA_URL = 'http://localhost:11434/api/generate'
const MODEL = 'qwen3-coder:30b'

const PROMPT =
  'The text below was read from the user\'s screen. Work out what they need ' +
  'and answer it directly and concisely.\n' +
  '- Coding / LeetCode problem: give the approach, then the code, then ' +
  'time and space complexity.\n' +
  '- Error message or stack trace: give the diagnosis, then the fix.\n' +
  '- Article or prose: give a short summary.\n' +
  '- Terminal output: give the root cause, then the commands to run.\n' +
  'If the user gives a request, follow it exactly. Answer only, no preamble.\n'

// Used when the user types nothing into the overlay input.
const DEFAULT_REQUEST = 'Understand and help with what is on screen.'

// Combine the screen context with the user's question (or the default).
function buildPrompt(text, question) {
  const request = (question && question.trim()) ? question.trim() : DEFAULT_REQUEST
  return PROMPT +
    '\nVisible content:\n' + text +
    '\n\nUser request:\n' + request +
    '\n\nGenerate a helpful answer.'
}

async function streamSolve(text, question, onChunk, signal) {
  let answer = ''
  try {
    const response = await fetch(OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        prompt: buildPrompt(text, question),
        stream: true,
      }),
      signal,
    })

    if (!response.ok) {
      throw new Error(`Ollama request failed: ${response.status}`)
    }

    // Ollama streams newline-delimited JSON: one { response, done } per token.
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let nl
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line) continue
        let obj
        try { obj = JSON.parse(line) } catch (e) { continue }
        if (obj.response) {
          answer += obj.response
          onChunk(obj.response)
        }
      }
    }
  } catch (e) {
    // Stop button aborts the fetch; keep whatever was generated so far.
    if (signal && signal.aborted) return answer.trim()
    throw e
  }
  return answer.trim()
}

module.exports = { streamSolve }
