// Headless driver for the transcribe+merge pipeline against a recording dir.
// Usage: npx tsx scripts/test-pipeline.ts <recording-dir> [micEpochMs] [systemEpochMs]
import { join, resolve } from 'node:path'
import { formatTranscript, mergeTranscripts } from '../src/main/merge'
import { convertTo16k, transcribeWav } from '../src/main/transcribe'

const dir = resolve(process.argv[2] ?? 'data/recordings/pipeline-test')
const micEpochMs = Number(process.argv[3] ?? 0)
const systemEpochMs = Number(process.argv[4] ?? 5000)
const modelPath = resolve('data/models/ggml-large-v3-turbo.bin')

const mic16k = join(dir, 'mic-16k.wav')
const system16k = join(dir, 'system-16k.wav')
await convertTo16k(join(dir, 'mic.wav'), mic16k)
await convertTo16k(join(dir, 'system.wav'), system16k)

console.error('transcribing mic...')
const micSegments = await transcribeWav(mic16k, modelPath)
console.error('transcribing system...')
const systemSegments = await transcribeWav(system16k, modelPath)

const segments = mergeTranscripts(
  { segments: micSegments, epochMs: micEpochMs },
  { segments: systemSegments, epochMs: systemEpochMs }
)
console.log(formatTranscript(segments))
