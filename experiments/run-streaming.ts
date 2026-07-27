// Streams a recorded meeting's 16 kHz WAVs through the chunked streaming
// transcriber (simulating live capture with 1 s pushes) and scores the result
// against the app's existing full-file whisper output, treated as ground truth.
// Usage: npx tsx experiments/run-streaming.ts [recording-dir]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseWhisperJson } from '../src/main/transcribe'
import { wordErrorRate } from './lib/wer'
import { StreamingTranscriber } from './streaming/streaming-transcriber'

const dir = resolve(process.argv[2] ?? 'data/recordings/ba784f46-7a20-470c-9af5-5a3d96d9cd8c')
const modelPath = resolve('data/models/ggml-large-v3-turbo.bin')
const outDir = resolve('experiments/results/streaming')
mkdirSync(outDir, { recursive: true })

/** Locate the data chunk in a RIFF WAV and return its PCM payload. */
function wavPcm(path: string): Buffer {
  const file = readFileSync(path)
  let offset = 12
  while (offset + 8 <= file.length) {
    const id = file.toString('ascii', offset, offset + 4)
    const size = file.readUInt32LE(offset + 4)
    if (id === 'data') return file.subarray(offset + 8, offset + 8 + size)
    offset += 8 + size + (size % 2)
  }
  throw new Error(`no data chunk in ${path}`)
}

const PUSH_BYTES = 32000 // 1 s of 16 kHz mono s16le, like a live capture callback

async function runStream(name: 'mic' | 'system') {
  const pcm = wavPcm(join(dir, `${name}-16k.wav`))
  const fullText = parseWhisperJson(readFileSync(join(dir, `${name}-16k.json`), 'utf-8'))
    .map((s) => s.text.trim())
    .join(' ')

  const transcriber = new StreamingTranscriber({
    modelPath,
    workDir: join(outDir, `${name}-work`),
    onChunk: ({ index, endMs, text }) =>
      console.error(`${name} chunk ${index} @ ${(endMs / 1000).toFixed(0)}s: ${text.length} chars`)
  })

  const started = Date.now()
  for (let i = 0; i < pcm.length; i += PUSH_BYTES) {
    transcriber.push(pcm.subarray(i, i + PUSH_BYTES))
  }
  const chunks = await transcriber.finish()
  const elapsedS = (Date.now() - started) / 1000

  const streamingText = chunks
    .flatMap((c) => c.segments.map((s) => s.text.trim()))
    .join(' ')
    .trim()

  writeFileSync(
    join(outDir, `${name}-chunks.json`),
    JSON.stringify(
      chunks.map((c) => ({
        index: c.index,
        startMs: c.startMs,
        endMs: c.endMs,
        skippedAsSilent: c.skippedAsSilent,
        text: c.segments.map((s) => s.text.trim()).join(' ')
      })),
      null,
      2
    )
  )
  writeFileSync(join(outDir, `${name}-streaming.txt`), streamingText)
  writeFileSync(join(outDir, `${name}-full.txt`), fullText)

  return {
    stream: name,
    audioSeconds: pcm.length / 32000,
    transcribeSeconds: elapsedS,
    chunks: chunks.length,
    silentChunksSkipped: chunks.filter((c) => c.skippedAsSilent).length,
    werVsFull: wordErrorRate(fullText, streamingText)
  }
}

const results = [await runStream('mic'), await runStream('system')]
writeFileSync(
  resolve('experiments/results/streaming-vs-full.json'),
  JSON.stringify(results, null, 2)
)
console.log(JSON.stringify(results, null, 2))
