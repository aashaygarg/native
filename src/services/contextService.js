// Identity context (Phase 8):
//   question (+ what's on screen) -> which identity docs to inject -> text
//
// Native can personalise an answer with three documents the user owns:
//   master_cv.md       — their CV
//   job_description.md — the role they're interviewing for
//   about_me.md        — preferences / short bio
//
// The docs are read ONCE at startup and kept in memory. No embeddings, no
// retrieval, no vector DB, no history — just file reads and string selection.
//
// Which docs to inject depends on the kind of question (Injection Policy):
//   LeetCode / compiler errors -> none
//   behavioural                -> cv + jd + about
//   resume                     -> cv + jd
//   system design              -> jd + about
//   general interview          -> cv + jd + about

const fs = require('fs')
const path = require('path')

const DATA_DIR = path.join(__dirname, '..', '..', 'data')

function loadDoc(name) {
  try {
    return fs.readFileSync(path.join(DATA_DIR, name), 'utf8').trim()
  } catch (e) {
    return ''
  }
}

// Loaded once, kept in memory.
const DOCS = {
  cv: loadDoc('master_cv.md'),
  jd: loadDoc('job_description.md'),
  about: loadDoc('about_me.md'),
}

// Which docs the user has enabled in Settings (all on by default).
let enabled = { cv: true, jd: true, about: true }

function setEnabled(partial) {
  enabled = { ...enabled, ...partial }
}

function getEnabled() {
  return { ...enabled }
}

// Which docs actually have content (so Settings can grey out missing ones).
function available() {
  return { cv: !!DOCS.cv, jd: !!DOCS.jd, about: !!DOCS.about }
}

// Coding problems and errors are detected from the screen text (and question),
// since the user often types nothing on those screens.
const isLeetCode = (s) =>
  /leetcode|class\s+solution|given an? (array|string|integer|linked list|binary tree)|example\s*\d*\s*:|constraints\s*:|return the|two sum|subarray|time complexity|space complexity|o\(n/i.test(s)
const isCompilerError = (s) =>
  /\berror\b|exception|traceback|stack trace|cannot find|undefined reference|segmentation fault|syntaxerror|typeerror|referenceerror|\bTS\d{3,}\b|panic:|expected .*(found|but)/i.test(s)

// Question-intent categories.
const isBehavioral = (q) =>
  /tell me about yourself|about yourself|your (greatest )?(strength|weakness)|describe a (time|situation)|tell me about a time|why (do you want|this company|should we hire|you)|biggest (challenge|failure|achievement)|conflict|\bstar\b|behaviou?ral/i.test(q)
const isResume = (q) =>
  /resume|\bcv\b|walk me through|your experience|your background|your projects|career|work history/i.test(q)
const isSystemDesign = (q) =>
  /system design|design a |design an |architecture|scalab|high.?level design|\bhld\b|\blld\b|microservice|distributed|throughput|load balanc/i.test(q)

// Decide which docs the policy wants for this question/screen.
function pick(question, screenText) {
  const q = question || ''
  const s = (screenText || '') + ' ' + q
  if (isLeetCode(s) || isCompilerError(s)) return {}
  if (isBehavioral(q)) return { cv: true, jd: true, about: true }
  if (isResume(q)) return { cv: true, jd: true }
  if (isSystemDesign(q)) return { jd: true, about: true }
  return { cv: true, jd: true, about: true } // general interview question
}

// Build the identity context string: policy ∩ enabled ∩ has-content.
function getIdentityContext(question, screenText) {
  const want = pick(question, screenText)
  const parts = []
  if (want.cv && enabled.cv && DOCS.cv) parts.push('## Master CV\n' + DOCS.cv)
  if (want.jd && enabled.jd && DOCS.jd) parts.push('## Job Description\n' + DOCS.jd)
  if (want.about && enabled.about && DOCS.about) parts.push('## About Me\n' + DOCS.about)
  return { text: parts.join('\n\n') }
}

module.exports = { getIdentityContext, setEnabled, getEnabled, available }
