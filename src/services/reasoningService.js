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

const { getIdentityContext } = require('./contextService')

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

// contextService joins the selected identity docs under fixed markers. Re-wrap
// each as a role-centric tag (target role first, as the authoritative source).
const IDENTITY_SECTIONS = [
  {
    marker: '## Job Description',
    tag: 'CURRENT_TARGET_ROLE',
    note: 'This section is authoritative. It defines the role and company currently being pursued.',
  },
  {
    marker: '## Master CV',
    tag: 'PAST_EXPERIENCE',
    note: 'This section describes historical experience only.',
  },
  {
    marker: '## About Me',
    tag: 'PREFERENCES',
    note: 'This section controls answer style.',
  },
]

function wrapIdentity(identityText) {
  if (!identityText) return ''
  // Locate each section's content using contextService's fixed markers.
  const present = []
  for (const sec of IDENTITY_SECTIONS) {
    const idx = identityText.indexOf(sec.marker + '\n')
    if (idx >= 0) present.push({ ...sec, idx })
  }
  const byPos = [...present].sort((a, b) => a.idx - b.idx)
  const content = {}
  for (let i = 0; i < byPos.length; i++) {
    const start = byPos[i].idx + byPos[i].marker.length + 1
    const end = i + 1 < byPos.length ? byPos[i + 1].idx : identityText.length
    content[byPos[i].tag] = identityText.slice(start, end).trim()
  }
  // Emit in authoritative order (target role first), each with its note.
  const out = []
  for (const sec of IDENTITY_SECTIONS) {
    if (content[sec.tag] == null) continue
    out.push('<' + sec.tag + '>\n' + content[sec.tag] + '\n\n' + sec.note + '\n</' + sec.tag + '>')
  }
  return out.join('\n\n')
}

// Combine identity context (if applicable), the screen context, and the user's
// question (or the default) into the prompt.
function buildPrompt(text, question) {
  const request = (question && question.trim()) ? question.trim() : DEFAULT_REQUEST
  const identity = wrapIdentity(getIdentityContext(question, text).text)
  let prompt = PROMPT
  if (identity) {
    prompt += '\n' + identity + '\n' +
      '\nRules:\n' +
      '1. CURRENT_TARGET_ROLE overrides PAST_EXPERIENCE whenever they conflict.\n' +
      '2. Never infer the current role from PAST_EXPERIENCE.\n' +
      '3. Questions about company, role, responsibilities, or fit must use CURRENT_TARGET_ROLE.\n' +
      '4. Use PAST_EXPERIENCE only to justify fit.\n' +
      '5. Use PREFERENCES only for answer style.\n' +
      '\nExample:\n' +
      'Question: "What role am I applying to?"\n' +
      'Correct: Use CURRENT_TARGET_ROLE.\n' +
      'Wrong: Use PAST_EXPERIENCE.\n'
  }
  prompt += '\nVisible content:\n' + text +
    '\n\nUser request:\n' + request +
    '\n\nGenerate a helpful answer.'
  return prompt
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
