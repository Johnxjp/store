// Replays a past recording through the live-transcription path as if it were
// live: the WAVs are copied header-first into a scratch dir and grown tick by
// tick while LiveTranscriber tail-reads them — exercising the real
// stat/tail-read/chunk code path — then every output is compared against the
// stored batch results for the same meeting (transcript WER, summary quality,
// cache-warm effectiveness, timing).
//
// Usage: npx tsx scripts/test-live-pipeline.ts <recording-dir>
//          [--chunk-seconds N] [--warm] [--summarize]
//
//   --warm       replay pokes a real SummaryWarmer per chunk, then measures
//                the final streamed request warm vs a cold control (model
//                unloaded first). Pass: warmed prefill < 15% of cold.
//   --summarize  generate notes from the live transcript and write a
//                side-by-side comparison.md against the stored baseline.
//
// Results land in experiments/results/live-pipeline-<shortid>/ (gitignored —
// meeting content is never committed).
import { mkdirSync, writeFileSync } from 'node:fs'
import { appendFile, mkdtemp, open, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { wordErrorRate } from '../experiments/lib/wer'
import { parseWavSampleRate } from '../src/main/chunker'
import { readConfig, type Config } from '../src/main/config'
import { buildSummaryPrompt, extractSummary, type ChatPrompt } from '../src/main/enhance'
import { LiveTranscriber } from '../src/main/live'
import { formatTranscript, mergeTranscripts } from '../src/main/merge'
import { SummaryWarmer } from '../src/main/warm'
import type { TranscriptSegment } from '../src/shared/types'

const TICK_SECONDS = 5

let recordingDir = ''
let chunkSeconds: number | undefined
let warm = false
let summarize = false
const args = process.argv.slice(2)
for (let i = 0; i < args.length; i++) {
  const arg = args[i]
  if (arg === '--chunk-seconds') chunkSeconds = Number(args[++i])
  else if (arg === '--warm') warm = true
  else if (arg === '--summarize') summarize = true
  else recordingDir = resolve(arg)
}
if (!recordingDir) {
  console.error(
    'usage: npx tsx scripts/test-live-pipeline.ts <recording-dir> [--chunk-seconds N] [--warm] [--summarize]'
  )
  process.exit(1)
}

const meetingId = basename(recordingDir)
const shortId = meetingId.slice(0, 8)
const outDir = `experiments/results/live-pipeline-${shortId}`
mkdirSync(outDir, { recursive: true })

const anchors = JSON.parse(await readFile(join(recordingDir, 'session.json'), 'utf-8')) as {
  micEpochMs: number
  systemEpochMs: number
}

const db = new DatabaseSync('data/db.sqlite', { readOnly: true })
const meeting = db
  .prepare(
    'select title, created_at as createdAt, enhanced_notes as enhancedNotes from meetings where id = ?'
  )
  .get(meetingId) as { title: string; createdAt: number; enhancedNotes: string | null } | undefined
if (!meeting) throw new Error(`meeting ${meetingId} not in the database`)
const batchSegments = db
  .prepare(
    'select speaker, start_ms as startMs, end_ms as endMs, text from transcript_segments where meeting_id = ? order by start_ms'
  )
  .all(meetingId) as unknown as TranscriptSegment[]
if (batchSegments.length === 0)
  throw new Error(`meeting ${meetingId} has no stored batch transcript`)
db.close()

const dateLabel = new Date(meeting.createdAt).toLocaleString()

// --- replay: grow header-only WAV copies tick by tick and drive tickOnce() ---

const scratch = await mkdtemp(join(tmpdir(), `live-replay-${shortId}-`))

interface SourceStream {
  name: string
  src: Awaited<ReturnType<typeof open>>
  size: number
  cursor: number
  bytesPerTick: number
  copyPath: string
}

const streams: SourceStream[] = []
for (const name of ['mic', 'system']) {
  const src = await open(join(recordingDir, `${name}.wav`), 'r')
  const { size } = await src.stat()
  const header = Buffer.alloc(44)
  await src.read(header, 0, 44, 0)
  const sampleRate = parseWavSampleRate(header)
  const copyPath = join(scratch, `${name}.wav`)
  writeFileSync(copyPath, header)
  streams.push({
    name,
    src,
    size,
    cursor: 44,
    bytesPerTick: sampleRate * 2 * TICK_SECONDS,
    copyPath
  })
}
const audioSeconds = Math.max(
  ...streams.map((s) => (s.size - 44) / (s.bytesPerTick / TICK_SECONDS || 1))
)

let warmer: SummaryWarmer | null = null
const live = new LiveTranscriber(scratch, {
  ...(chunkSeconds ? { chunkSeconds } : {}),
  onChunk: () => warmer?.poke()
})

// Mirrors buildWarmPrompt in ipc.ts: pinned title, production merge + builder.
function buildLivePrompt(): ChatPrompt | null {
  const snap = live.snapshot()
  const merged = mergeTranscripts(
    { segments: snap.mic, epochMs: anchors.micEpochMs },
    { segments: snap.system, epochMs: anchors.systemEpochMs },
    anchors.pauses ?? []
  )
  const config = readConfig()
  if (formatTranscript(merged).length > config.maxTranscriptChars) return null
  return buildSummaryPrompt(
    { title: meeting!.title, dateLabel, transcript: merged },
    config.maxTranscriptChars
  )
}

if (warm) {
  warmer = new SummaryWarmer(buildLivePrompt)
  warmer.poke() // meeting start: load the model + prefill the static prefix
}

const chunkLog: string[] = []
const origLog = console.log
console.log = (...logArgs: unknown[]) => {
  const line = logArgs.join(' ')
  if (line.startsWith('[live]') || line.startsWith('[transcribe]')) chunkLog.push(line)
  origLog(...logArgs)
}

const replayStart = Date.now()
let ticks = 0
while (streams.some((s) => s.cursor < s.size)) {
  for (const s of streams) {
    const n = Math.min(s.bytesPerTick, s.size - s.cursor)
    if (n <= 0) continue
    const buf = Buffer.alloc(n)
    await s.src.read(buf, 0, n, s.cursor)
    s.cursor += n
    await appendFile(s.copyPath, buf)
  }
  ticks++
  // The last tick's audio is left for finish() to read, as at a real Stop.
  if (streams.some((s) => s.cursor < s.size)) {
    await live.tickOnce()
    // Real meetings give the queue ~5s of wall time per tick and the warmer
    // a ~30s chunk cadence it comfortably beats (a chunk-delta warm is
    // ~1-4s). Without these waits the accelerated replay piles every chunk
    // into finish() and starves the warmer, measuring neither as it behaves
    // against a real-time meeting.
    await live.idle()
    if (warmer) await warmer.idle()
  }
}
const replayMs = Date.now() - replayStart

// --- Stop: warmer off, flush the tail, transcript ready ---

warmer?.stop()
const finishStart = Date.now()
const liveResult = await live.finish()
const finishMs = Date.now() - finishStart
console.log = origLog
for (const s of streams) await s.src.close()
if (!liveResult) throw new Error('live transcription was invalidated — see logs above')

const liveMerged = mergeTranscripts(
  { segments: liveResult.mic, epochMs: anchors.micEpochMs },
  { segments: liveResult.system, epochMs: anchors.systemEpochMs },
  anchors.pauses ?? []
)
await rm(scratch, { recursive: true, force: true })

// --- transcript accuracy vs the stored batch transcript ---

const liveText = formatTranscript(liveMerged)
const batchText = formatTranscript(batchSegments)
writeFileSync(join(outDir, 'transcript-live.md'), liveText + '\n')
writeFileSync(join(outDir, 'transcript-batch.md'), batchText + '\n')

const joined = (segments: TranscriptSegment[], speaker?: string) =>
  segments
    .filter((s) => !speaker || s.speaker === speaker)
    .map((s) => s.text)
    .join(' ')
// Merged-order WER counts interleaving shifts as edits; the per-speaker
// numbers isolate actual transcription divergence within each stream.
const wer = {
  merged: wordErrorRate(joined(batchSegments), joined(liveMerged)),
  me: wordErrorRate(joined(batchSegments, 'me'), joined(liveMerged, 'me')),
  them: wordErrorRate(joined(batchSegments, 'them'), joined(liveMerged, 'them'))
}
writeFileSync(join(outDir, 'wer.json'), JSON.stringify(wer, null, 2) + '\n')

const timings = {
  meetingId,
  audioSeconds: Math.round(audioSeconds),
  chunkSeconds: chunkSeconds ?? 30,
  tickSeconds: TICK_SECONDS,
  ticks,
  replayMs,
  finishMs,
  liveSegments: { mic: liveResult.mic.length, system: liveResult.system.length },
  chunkLog
}
writeFileSync(join(outDir, 'timings.json'), JSON.stringify(timings, null, 2) + '\n')

// --- final summary request: warm-vs-cold stats and/or summary comparison ---

interface ChatStats {
  ttftMs: number
  totalMs: number
  loadMs: number | null
  promptEvalCount: number | null
  promptEvalMs: number | null
  evalCount: number | null
}

interface OllamaChunk {
  message?: { content?: string }
  done?: boolean
  load_duration?: number
  prompt_eval_count?: number
  prompt_eval_duration?: number
  eval_count?: number
}

async function timedChat(
  prompt: ChatPrompt,
  config: Config
): Promise<ChatStats & { content: string }> {
  const started = Date.now()
  const res = await fetch(`${config.ollamaUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.ollamaModel,
      stream: true,
      options: { temperature: 0, num_ctx: config.numCtx },
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user }
      ]
    })
  })
  if (!res.ok || !res.body) throw new Error(`Ollama error ${res.status}: ${await res.text()}`)
  let content = ''
  let ttftMs = -1
  let final: OllamaChunk | null = null
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffered = ''
  const handleLine = (line: string) => {
    if (!line.trim()) return
    const chunk = JSON.parse(line) as OllamaChunk
    if (chunk.message?.content) {
      if (ttftMs < 0) ttftMs = Date.now() - started
      content += chunk.message.content
    }
    if (chunk.done) final = chunk
  }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffered += decoder.decode(value, { stream: true })
    const lines = buffered.split('\n')
    buffered = lines.pop()!
    lines.forEach(handleLine)
  }
  handleLine(buffered)
  const ns = (v?: number) => (v === undefined ? null : Math.round(v / 1e6))
  return {
    content,
    ttftMs,
    totalMs: Date.now() - started,
    loadMs: ns(final?.load_duration),
    promptEvalCount: final?.prompt_eval_count ?? null,
    promptEvalMs: ns(final?.prompt_eval_duration),
    evalCount: final?.eval_count ?? null
  }
}

async function unloadModel(config: Config): Promise<void> {
  await fetch(`${config.ollamaUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: config.ollamaModel, messages: [], keep_alive: 0 })
  })
}

let newSummaryRaw: string | null = null
if (warm || summarize) {
  const config = readConfig()
  const finalPrompt = buildSummaryPrompt(
    { title: meeting.title, dateLabel, transcript: liveMerged },
    config.maxTranscriptChars
  )

  if (warm) {
    // The plan's cold-first order would need a second replay for identical
    // prompt bytes; warmed-first then unload-and-cold measures the same two
    // numbers from one replay.
    console.log('[harness] final summary request (warm cache)…')
    const warmed = await timedChat(finalPrompt, config)
    console.log(
      `[harness] warmed: prefill ${warmed.promptEvalCount} tokens in ${warmed.promptEvalMs}ms, TTFT ${warmed.ttftMs}ms`
    )
    console.log('[harness] unloading model for the cold control…')
    await unloadModel(config)
    const cold = await timedChat(finalPrompt, config)
    console.log(
      `[harness] cold: prefill ${cold.promptEvalCount} tokens in ${cold.promptEvalMs}ms, TTFT ${cold.ttftMs}ms`
    )
    const { content, ...warmedStats } = warmed
    const { content: coldContent, ...coldStats } = cold
    void coldContent
    // This Ollama reports prompt_eval_count as the full prompt size even on
    // a cache hit (verified: identical prompt → count unchanged, duration
    // 0.06s), so warm effectiveness is measured on prefill *duration* —
    // proportional to the tokens actually evaluated.
    const ratio =
      warmed.promptEvalMs !== null && cold.promptEvalMs !== null
        ? warmed.promptEvalMs / cold.promptEvalMs
        : null
    const warmStats = {
      warmed: warmedStats,
      cold: coldStats,
      warmPrefillRatio: ratio === null ? null : Number(ratio.toFixed(3)),
      warmRatioTargetMet: ratio !== null && ratio < 0.15,
      stopToFirstTokenMs: finishMs + warmed.ttftMs,
      stopToNotesMs: finishMs + warmed.totalMs
    }
    writeFileSync(join(outDir, 'warm-stats.json'), JSON.stringify(warmStats, null, 2) + '\n')
    newSummaryRaw = content
  } else {
    newSummaryRaw = (await timedChat(finalPrompt, config)).content
  }
}

if (summarize && newSummaryRaw !== null) {
  const notes = extractSummary(newSummaryRaw)
  const comparison = [
    `# ${meeting.title} — summary comparison`,
    '',
    '## Baseline (stored batch summary)',
    '',
    meeting.enhancedNotes ?? '_(none stored)_',
    '',
    '---',
    '',
    '## Live path (this replay)',
    '',
    notes
  ].join('\n')
  writeFileSync(join(outDir, 'comparison.md'), comparison + '\n')
}

console.log('')
console.log(`=== ${meeting.title} (${shortId}) — ${Math.round(audioSeconds / 60)} min ===`)
console.log(
  `replay ${(replayMs / 1000).toFixed(1)}s (${ticks} ticks) · stop→transcript ${(finishMs / 1000).toFixed(1)}s`
)
console.log(
  `WER vs batch: merged ${(wer.merged.wer * 100).toFixed(2)}% · ` +
    `Me ${(wer.me.wer * 100).toFixed(2)}% · Them ${(wer.them.wer * 100).toFixed(2)}% ` +
    `(${wer.merged.editDistance} edits over ${wer.merged.refWords} words) — target < 5%`
)
if (warm) console.log(`warm stats written to ${outDir}/warm-stats.json`)
console.log(`results in ${outDir}/`)
