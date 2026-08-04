import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { StreamSegment } from './merge'
import { asrModelsDir, fluidTranscribeBin } from './paths'

const execFileAsync = promisify(execFile)

/** GUI-launched apps don't inherit the shell PATH, so fall back to Homebrew. */
export function resolveBin(name: string): string {
  const brew = join('/opt/homebrew/bin', name)
  return existsSync(brew) ? brew : name
}

/**
 * Streams that never peak above this are treated as silent and skipped entirely —
 * transcribing silence wastes time and can only produce garbage. Gate on peak,
 * not mean: a mic that's live only while its owner talks averages below any
 * sane mean threshold over a long meeting even though it holds real speech.
 * Real speech peaks above -30 dB even on a quiet mic; dead streams sit near
 * -91 dB.
 */
export const SILENCE_MAX_DB = -40

export function isSilent(maxVolumeDb: number): boolean {
  return maxVolumeDb < SILENCE_MAX_DB
}

/**
 * Quiet-but-audible streams (e.g. a low-gain mic ~25 dB under the system
 * stream) are boosted so their peak lands at TARGET_PEAK_DB before the ASR
 * model sees them. Boosts under MIN_BOOST_DB aren't worth a re-encode.
 */
export const TARGET_PEAK_DB = -3
const MIN_BOOST_DB = 3

export function boostGainDb(maxVolumeDb: number): number {
  const gain = TARGET_PEAK_DB - maxVolumeDb
  return gain >= MIN_BOOST_DB ? gain : 0
}

/** ffmpeg's volumedetect reports on stderr; missing report = no audio = silent. */
export function parseMaxVolumeDb(ffmpegStderr: string): number {
  const match = ffmpegStderr.match(/max_volume:\s*(-?[\d.]+)\s*dB/)
  return match ? Number(match[1]) : -Infinity
}

export async function measureMaxVolumeDb(wavPath: string): Promise<number> {
  const { stderr } = await execFileAsync(resolveBin('ffmpeg'), [
    '-i',
    wavPath,
    '-af',
    'volumedetect',
    '-f',
    'null',
    '-'
  ])
  return parseMaxVolumeDb(stderr)
}

export async function convertTo16k(srcWav: string, destWav: string, gainDb = 0): Promise<void> {
  const args = ['-y', '-i', srcWav, '-ar', '16000', '-ac', '1']
  if (gainDb > 0) args.push('-af', `volume=${gainDb}dB`)
  args.push(destWav)
  await execFileAsync(resolveBin('ffmpeg'), args)
}

/**
 * Transcribes with the fluid-transcribe helper (parakeet v2 via FluidAudio
 * CoreML — see experiments/README.md §5 for the whisper comparison that led
 * here). The helper downloads the models into asrModelsDir on first run.
 */
export async function transcribeWav(wav16kPath: string): Promise<StreamSegment[]> {
  const outJson = wav16kPath.replace(/\.wav$/, '.json')
  await execFileAsync(fluidTranscribeBin, [asrModelsDir, wav16kPath, outJson])
  const raw = await readFile(outJson, 'utf-8')
  return wordsToSegments(parseFluidJson(raw))
}

export interface FluidWord {
  word: string
  /** Seconds from the start of the WAV. */
  start: number
  end: number
}

export function parseFluidJson(raw: string): FluidWord[] {
  const parsed = JSON.parse(raw) as { words?: FluidWord[] }
  return parsed.words ?? []
}

/**
 * A pause this long between words starts a new segment even mid-sentence, so
 * a long monologue can still interleave with the other stream's segments.
 * Must stay below merge's COALESCE_GAP_MS or same-speaker splits rejoin anyway.
 */
const SEGMENT_GAP_S = 1.5

const SENTENCE_END = /[.!?…]["')\]]*$/

/**
 * Groups the helper's word timings into sentence-level segments — parakeet v2
 * emits punctuation, so sentence ends are detectable from the text. Segment
 * granularity only affects how the two streams interleave in the merge;
 * same-speaker neighbours are coalesced there afterwards.
 */
export function wordsToSegments(words: FluidWord[]): StreamSegment[] {
  const segments: StreamSegment[] = []
  let run: FluidWord[] = []

  const flush = (): void => {
    if (run.length === 0) return
    segments.push({
      fromMs: Math.round(run[0].start * 1000),
      toMs: Math.round(run[run.length - 1].end * 1000),
      text: run.map((w) => w.word).join(' ')
    })
    run = []
  }

  for (const word of words) {
    if (run.length > 0 && word.start - run[run.length - 1].end >= SEGMENT_GAP_S) flush()
    run.push(word)
    if (SENTENCE_END.test(word.word)) flush()
  }
  flush()
  return segments
}
