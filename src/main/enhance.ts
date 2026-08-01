import type { TranscriptSegment } from '../shared/types'
import { formatTranscript } from './merge'

const OLLAMA_URL = 'http://localhost:11434/api/chat'
// ~4 chars/token heuristic; qwen3.6 handles 256k tokens, cap input well below.
const MAX_TRANSCRIPT_CHARS = 400_000

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
  const system = [
    'You will be passed a transcript of a recorded meeting that tags the',
    'speaker as "Me" and other participants as "Them". Your task is to',
    'summarise the meeting notes. The summary should contain a brief overview',
    'of the core purpose of the meeting, a list of key topics covered, any',
    'key decisions made, and finally any action items mentioned. An action',
    'item should be specific and actionable, not just information. Only',
    'include information that exists, there is no need to state the negative.',
    'When outputting action items, tag the responsible individuals if',
    'specified, and attach due dates or deadlines when mentioned. When',
    'referring to the primary user ("Me") use active voice and drop the',
    'pronoun, e.g. "I will follow up" becomes "Follow up". If the meeting',
    'does not have sufficient information, simply provide a brief summary of',
    'what is available — do not force or hallucinate information to fit the',
    'categories above. Format the note into those sections when the',
    'information clearly fits; otherwise leave the note unformatted if it is',
    'short or missing sections. No preamble, no commentary — output the notes',
    'only.'
  ].join(' ')

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
      options: { temperature: 0.3 },
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
