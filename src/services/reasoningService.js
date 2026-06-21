// Reasoning (Phase 5):
//   OCR text -> qwen3-coder -> answer
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
  'Answer only, no preamble.\n\n' +
  'Screen text:\n'

async function solve(text) {
  const response = await fetch(OLLAMA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      prompt: PROMPT + text,
      stream: false,
    }),
  })

  if (!response.ok) {
    throw new Error(`Ollama request failed: ${response.status}`)
  }

  const data = await response.json()
  return { answer: (data.response || '').trim() }
}

module.exports = { solve }
