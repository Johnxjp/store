// Headless driver for summary generation: transcript segments in, notes out.
// Usage: npx tsx scripts/test-enhance.ts
import { readConfig } from '../src/main/config'
import { buildSummaryPrompt, generateNotes } from '../src/main/enhance'
import type { TranscriptSegment } from '../src/shared/types'

const transcript: TranscriptSegment[] = [
  {
    speaker: 'me',
    startMs: 0,
    endMs: 4000,
    text: 'Morning. Can we go over the launch plan and the open QA issues?'
  },
  {
    speaker: 'them',
    startMs: 5000,
    endMs: 14000,
    text: 'Sure. Launch is set for October 14th. QA found two blockers: the export crash on large files and the login timeout on slow networks.'
  },
  {
    speaker: 'me',
    startMs: 15000,
    endMs: 20000,
    text: 'Who owns the export crash? I can take the login timeout since I wrote that retry logic.'
  },
  {
    speaker: 'them',
    startMs: 21000,
    endMs: 30000,
    text: 'Priya has the export crash, fix due Friday. If both are closed by Monday we stay on schedule, otherwise we slip a week.'
  },
  {
    speaker: 'me',
    startMs: 31000,
    endMs: 36000,
    text: 'Understood. I will have the timeout fix in review by Thursday and update the release doc today.'
  },
  {
    speaker: 'them',
    startMs: 37000,
    endMs: 41000,
    text: 'Great. Let us also drop the beta banner before launch — marketing asked for that.'
  }
]

const config = readConfig()
const prompt = buildSummaryPrompt(
  {
    title: 'Launch readiness sync',
    dateLabel: '13 July 2026',
    transcript
  },
  config.maxTranscriptChars
)
console.error('calling ollama...')
const started = Date.now()
const notes = await generateNotes(prompt, {
  ...config,
  ollamaModel: process.argv[2] ?? 'llama3.2'
})
console.error(`done in ${((Date.now() - started) / 1000).toFixed(1)}s\n`)
console.log(notes)
