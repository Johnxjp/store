// Headless driver for the transcribe+merge pipeline against a recording dir.
// Mirrors the app pipeline: silence gate + gain boost + parallel transcription.
// Usage: npx tsx scripts/test-pipeline.ts <recording-dir> [micEpochMs] [systemEpochMs]
// Epoch anchors default to the dir's session.json when present.
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { formatTranscript, mergeTranscripts, type StreamSegment } from '../src/main/merge'
import {
  boostGainDb,
  convertTo16k,
  isSilent,
  measureMaxVolumeDb,
  transcribeWav
} from '../src/main/transcribe'

const dir = resolve(process.argv[2] ?? 'data/recordings/pipeline-test')
const sessionPath = join(dir, 'session.json')
const session = existsSync(sessionPath)
  ? (JSON.parse(readFileSync(sessionPath, 'utf-8')) as {
      micEpochMs: number
      systemEpochMs: number
    })
  : null
const micEpochMs = Number(process.argv[3] ?? session?.micEpochMs ?? 0)
const systemEpochMs = Number(process.argv[4] ?? session?.systemEpochMs ?? 5000)

async function prepare(name: 'mic' | 'system'): Promise<string | null> {
  const wav16k = join(dir, `${name}-16k.wav`)
  await convertTo16k(join(dir, `${name}.wav`), wav16k)
  const maxDb = await measureMaxVolumeDb(wav16k)
  if (isSilent(maxDb)) {
    console.error(`${name}: peak ${maxDb.toFixed(1)} dB — silent, skipping`)
    return null
  }
  const gain = boostGainDb(maxDb)
  if (gain > 0) {
    console.error(`${name}: peak ${maxDb.toFixed(1)} dB — boosting +${gain.toFixed(1)} dB`)
    await convertTo16k(join(dir, `${name}.wav`), wav16k, gain)
  } else {
    console.error(`${name}: peak ${maxDb.toFixed(1)} dB`)
  }
  return wav16k
}

const [mic16k, system16k] = await Promise.all([prepare('mic'), prepare('system')])

console.error('transcribing...')
const started = Date.now()
const empty: StreamSegment[] = []
const [micSegments, systemSegments] = await Promise.all([
  mic16k ? transcribeWav(mic16k) : empty,
  system16k ? transcribeWav(system16k) : empty
])
console.error(`transcribed in ${((Date.now() - started) / 1000).toFixed(1)}s`)

const segments = mergeTranscripts(
  { segments: micSegments, epochMs: micEpochMs },
  { segments: systemSegments, epochMs: systemEpochMs }
)
console.log(formatTranscript(segments))
