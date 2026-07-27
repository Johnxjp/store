import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { WhisperSegment } from './merge'

const execFileAsync = promisify(execFile)

/** GUI-launched apps don't inherit the shell PATH, so fall back to Homebrew. */
export function resolveBin(name: string): string {
  const brew = join('/opt/homebrew/bin', name)
  return existsSync(brew) ? brew : name
}

/**
 * Streams that never peak above this are treated as silent and skipped entirely —
 * Whisper hallucinates plausible text on silence, so it must never see it.
 * Gate on peak, not mean: a mic that's live only while its owner talks averages
 * below any sane mean threshold over a long meeting even though it holds real
 * speech. Real speech peaks above -30 dB even on a quiet mic; dead streams sit
 * near -91 dB.
 */
export const SILENCE_MAX_DB = -40

export function isSilent(maxVolumeDb: number): boolean {
  return maxVolumeDb < SILENCE_MAX_DB
}

/**
 * Quiet-but-audible streams (e.g. a low-gain mic ~25 dB under the system
 * stream) are boosted so their peak lands at TARGET_PEAK_DB before Whisper
 * sees them. Boosts under MIN_BOOST_DB aren't worth a re-encode.
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

export async function transcribeWav(
  wav16kPath: string,
  modelPath: string
): Promise<WhisperSegment[]> {
  const outBase = wav16kPath.replace(/\.wav$/, '')
  await execFileAsync(
    resolveBin('whisper-cli'),
    [
      '-m',
      modelPath,
      '-f',
      wav16kPath,
      '--output-json',
      '--output-file',
      outBase,
      '--language',
      'en'
    ],
    { maxBuffer: 64 * 1024 * 1024 }
  )
  const raw = await readFile(`${outBase}.json`, 'utf-8')
  return parseWhisperJson(raw)
}

interface WhisperCliOutput {
  transcription?: Array<{ offsets: { from: number; to: number }; text: string }>
}

export function parseWhisperJson(raw: string): WhisperSegment[] {
  const parsed = JSON.parse(raw) as WhisperCliOutput
  return (parsed.transcription ?? []).map((t) => ({
    fromMs: t.offsets.from,
    toMs: t.offsets.to,
    text: t.text
  }))
}
