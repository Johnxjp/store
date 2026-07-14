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
    'You write meeting notes from a transcript. The transcript labels the',
    'note-taker as "Me" and all other participants as "Them".',
    'Produce clean markdown with exactly these sections:',
    '## Summary — 2-3 sentences on what the meeting was about and its outcome.',
    '## Discussion — the main topics, grouped under bold topic names, with the',
    'specifics that matter (decisions, numbers, names, reasons).',
    '## Decisions — bullet list of decisions made; omit the section if none.',
    '## Action items — bullet list with owner (Me/Them) when clear; omit if none.',
    'Never invent anything that is not in the transcript. No preamble, no',
    'commentary — output the notes only.'
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
