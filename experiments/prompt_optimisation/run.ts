// Runs prompt variants against the test transcripts via Ollama and writes
// each output to outputs/<variant>-<input>.md for side-by-side comparison.
// Usage: npx tsx experiments/prompt_optimisation/run.ts [variantName ...]
// Env: MODEL (default qwen2.5:14b), INPUTS (comma-separated, default all)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatTranscript } from '../../src/main/merge'
import type { TranscriptSegment } from '../../src/shared/types'
import { variants } from './prompts'

const here = dirname(fileURLToPath(import.meta.url))
const OLLAMA_URL = 'http://localhost:11434/api/chat'
const MODEL = process.env.MODEL ?? 'qwen2.5:14b'

interface TestInput {
  name: string
  file: string
  title: string
  dateLabel: string
}

const inputs: TestInput[] = [
  {
    name: 'interview',
    file: 'interview_transcript.json',
    title: 'Hiring Manager Interview',
    dateLabel: '4 August 2026'
  },
  {
    name: 'catchup',
    file: 'catchup_transcript.json',
    title: 'Meeting 27 Jul, 08:59',
    dateLabel: '27 July 2026'
  }
]

interface RawSegment {
  speaker: 'me' | 'them'
  start_ms: number
  end_ms: number
  text: string
}

function buildUser(input: TestInput): string {
  const raw: RawSegment[] = JSON.parse(readFileSync(join(here, input.file), 'utf8'))
  const transcript: TranscriptSegment[] = raw.map((s) => ({
    speaker: s.speaker,
    startMs: s.start_ms,
    endMs: s.end_ms,
    text: s.text
  }))
  return [
    `Meeting: ${input.title}`,
    `Date: ${input.dateLabel}`,
    '',
    '### Transcript',
    formatTranscript(transcript)
  ].join('\n')
}

const requested = process.argv.slice(2)
const toRun = requested.length ? variants.filter((v) => requested.includes(v.name)) : variants
if (requested.length && toRun.length !== requested.length) {
  const known = new Set(variants.map((v) => v.name))
  throw new Error(`unknown variant(s): ${requested.filter((n) => !known.has(n)).join(', ')}`)
}
const inputFilter = process.env.INPUTS?.split(',')
const inputsToRun = inputFilter ? inputs.filter((i) => inputFilter.includes(i.name)) : inputs

mkdirSync(join(here, 'outputs'), { recursive: true })

for (const variant of toRun) {
  for (const input of inputsToRun) {
    const label = `${variant.name}-${input.name}`
    console.error(`[${label}] calling ${MODEL} (options ${JSON.stringify(variant.options)})...`)
    const started = Date.now()
    const res = await fetch(OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        stream: false,
        options: variant.options,
        messages: [
          { role: 'system', content: variant.system },
          { role: 'user', content: buildUser(input) }
        ]
      })
    })
    if (!res.ok) throw new Error(`Ollama error ${res.status}: ${await res.text()}`)
    const data = (await res.json()) as { message?: { content?: string } }
    const content = data.message?.content?.trim()
    if (!content) throw new Error(`[${label}] empty response`)
    const outPath = join(here, 'outputs', `${label}.md`)
    writeFileSync(outPath, content + '\n')
    console.error(`[${label}] done in ${((Date.now() - started) / 1000).toFixed(1)}s → ${outPath}`)
  }
}
