import type { TranscriptSegment } from '../shared/types'
import { formatTranscript } from './merge'

const OLLAMA_URL = 'http://localhost:11434/api/chat'
// Must fit NUM_CTX with room for the system prompt and the generated notes:
// ~4 chars/token → 110k chars ≈ 27k tokens, leaving ~5k of the 32k window.
const MAX_TRANSCRIPT_CHARS = 110_000
// Without an explicit num_ctx Ollama defaults to 4096 and silently truncates
// the transcript (a 1h meeting is ~16k tokens). 32768 is qwen2.5's native max.
const NUM_CTX = 32_768

export interface SummaryInput {
  title: string
  dateLabel: string
  transcript: TranscriptSegment[]
}

export interface ChatPrompt {
  system: string
  user: string
}

export function buildSummaryPrompt(input: SummaryInput): ChatPrompt {
  // Iterated against real transcripts in experiments/prompt_optimisation
  // (winning variant v11) — see the ANALYSIS.md there before rewording:
  // qwen2.5:14b regresses on attribution from small perturbations.
  const system = [
    'You are writing meeting notes from the transcript of a recorded meeting.',
    'The transcript labels the note-taker\'s side as "Me" and everyone else as',
    '"Them". Work out participants\' names and roles from the conversation',
    'itself (introductions, sign-offs) and use those names in the notes. If a',
    'name or term is never explained, use it exactly as spoken — never guess',
    'or speculate about who or what it might be, and keep the "Me"/"Them"',
    'label for anyone whose name is never said.',
    '',
    'First, work out the core purpose of the meeting. Open the notes with a',
    'brief "Overview" section — a sentence or two that lets someone who was',
    'not there immediately understand what this meeting was about. The',
    'purpose then decides what belongs in the notes: conversation that does',
    'not serve it — the chat before things start, the pleasantries at the',
    'end — has no place in them, however long it went on.',
    '',
    'Structure the rest as markdown sections (# headings) named after the',
    'topics actually discussed, in the order they came up. The notes record',
    'what was said and learned — statements of substance, not a script of',
    'questions and answers. Under each heading, write bullets that capture',
    'that substance, and keep it concrete: every number, metric, deadline,',
    'company, product or tool name, and named event that was said belongs in',
    'the notes. When a speaker makes a point through a specific example or',
    'story, keep the example itself — who, what, the outcome — not a',
    'generalisation of it. A reader who missed the meeting should learn the',
    'same facts an attendee did, so be generous: a substantial topic usually',
    'needs several bullets, with nested bullets for sub-details. Record',
    'decisions in the section where they were made.',
    '',
    'If anyone committed to doing something, end with a "Next steps" section',
    'listing those commitments, each with its owner and any deadline',
    'mentioned; otherwise, leave the section out entirely.',
    'Commitments are often made while wrapping up — a promise made',
    'during the goodbyes still belongs in "Next steps". The owner is the',
    'speaker of the sentence that made the commitment: "I\'ll send my notes',
    'over" spoken by a "Them" participant is that person\'s commitment, not',
    "the note-taker's. For the note-taker's own commitments, drop the pronoun",
    'and use active voice ("Follow up with…"). Omit any section with nothing',
    'in it and never state that something did not happen.',
    '',
    'Base every statement strictly on the transcript — no outside knowledge,',
    'no invented details. Ignore transcription artifacts such as repeated',
    'words, fillers and garbled fragments. Output the notes only — no',
    'preamble, no commentary.'
  ].join('\n')

  const user = [
    `Meeting: ${input.title}`,
    `Date: ${input.dateLabel}`,
    '',
    '### Transcript',
    truncateMiddle(formatTranscript(input.transcript), MAX_TRANSCRIPT_CHARS)
  ].join('\n')

  return { system, user }
}

export function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const half = Math.floor(maxChars / 2)
  return `${text.slice(0, half)}\n\n[... transcript truncated ...]\n\n${text.slice(-half)}`
}

interface OllamaChatResponse {
  message?: { content?: string }
}

export async function generateNotes(prompt: ChatPrompt, model: string): Promise<string> {
  const res = await fetch(OLLAMA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      options: { temperature: 0, num_ctx: NUM_CTX },
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user }
      ]
    })
  }).catch(() => {
    throw new Error('Cannot reach Ollama at localhost:11434 — is it running? (ollama serve)')
  })
  if (!res.ok) {
    throw new Error(`Ollama error ${res.status}: ${await res.text()}`)
  }
  const data = (await res.json()) as OllamaChatResponse
  const content = data.message?.content?.trim()
  if (!content) throw new Error('Ollama returned an empty response')
  return content
}
