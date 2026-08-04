// Merges parakeet per-stream sentence JSON into a Me/Them transcript, runs it
// through buildSummaryPrompt (whatever prompt src/main/enhance.ts currently
// holds) via Ollama, and saves everything next to the DB's current summary
// for side-by-side comparison.
// Run experiments/parakeet/transcribe_meeting.py first.
// Usage: npx tsx experiments/parakeet-summary.ts <meetingId>
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildSummaryPrompt, generateNotes } from '../src/main/enhance'
import { formatTranscript } from '../src/main/merge'
import type { TranscriptSegment } from '../src/shared/types'

const meetingId = process.argv[2]
if (!meetingId) throw new Error('usage: npx tsx experiments/parakeet-summary.ts <meetingId>')
const shortId = meetingId.slice(0, 8)
const outDir = `experiments/results/parakeet-summary-${shortId}`

const COALESCE_GAP_MS = 2000

interface Sentence {
  start: number
  end: number
  text: string
}

const anchors = JSON.parse(
  readFileSync(join('data/recordings', meetingId, 'session.json'), 'utf-8')
) as { micEpochMs: number; systemEpochMs: number }
const t0 = Math.min(anchors.micEpochMs, anchors.systemEpochMs)

const segments: TranscriptSegment[] = []
for (const [stream, speaker] of [
  ['mic', 'me'],
  ['system', 'them']
] as const) {
  const sentences = JSON.parse(
    readFileSync(join(outDir, `parakeet-${stream}.json`), 'utf-8')
  ) as Sentence[]
  const offset = (stream === 'mic' ? anchors.micEpochMs : anchors.systemEpochMs) - t0
  for (const s of sentences) {
    if (!s.text) continue
    segments.push({
      speaker,
      startMs: Math.round(offset + s.start * 1000),
      endMs: Math.round(offset + s.end * 1000),
      text: s.text
    })
  }
}
segments.sort((a, b) => a.startMs - b.startMs)

const coalesced: TranscriptSegment[] = []
for (const seg of segments) {
  const prev = coalesced[coalesced.length - 1]
  if (prev && prev.speaker === seg.speaker && seg.startMs - prev.endMs < COALESCE_GAP_MS) {
    prev.text += ` ${seg.text}`
    prev.endMs = Math.max(prev.endMs, seg.endMs)
  } else {
    coalesced.push({ ...seg })
  }
}

const db = new DatabaseSync('data/db.sqlite', { readOnly: true })
const meeting = db
  .prepare('select title, created_at, enhanced_notes from meetings where id = ?')
  .get(meetingId) as { title: string; created_at: number; enhanced_notes: string | null }
const config = JSON.parse(readFileSync('data/config.json', 'utf-8')) as { ollamaModel: string }

const dateLabel = new Date(meeting.created_at).toLocaleDateString('en-GB', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric'
})

writeFileSync(join(outDir, 'transcript-parakeet.md'), formatTranscript(coalesced) + '\n')
writeFileSync(join(outDir, 'summary-current.md'), (meeting.enhanced_notes ?? '(none)') + '\n')

console.log(`${coalesced.length} merged segments; summarizing with ${config.ollamaModel}...`)
const prompt = buildSummaryPrompt({ title: meeting.title, dateLabel, transcript: coalesced })
const started = Date.now()
const notes = await generateNotes(prompt, config.ollamaModel)
console.log(`summary in ${((Date.now() - started) / 1000).toFixed(0)}s`)
writeFileSync(join(outDir, 'summary-parakeet-newprompt.md'), notes + '\n')

const comparison = [
  `# ${meeting.title} — summary comparison`,
  '',
  `Meeting: ${meetingId} (${dateLabel})`,
  '',
  '## Current (whisper transcript + old prompt, from app DB)',
  '',
  meeting.enhanced_notes ?? '(none)',
  '',
  '## New (parakeet v2 transcript + new prompt)',
  '',
  `Model: ${config.ollamaModel}`,
  '',
  notes,
  ''
].join('\n')
writeFileSync(join(outDir, 'comparison.md'), comparison)
console.log(`saved to ${outDir}`)
