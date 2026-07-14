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
 * Streams quieter than this are treated as silent and skipped entirely —
 * Whisper hallucinates plausible text on silence, so it must never see it.
 * Speech sits around -35..-15 dB mean; ambient room noise below -55 dB.
 */
export const SILENCE_MEAN_DB = -50

export function isSilent(meanVolumeDb: number): boolean {
  return meanVolumeDb < SILENCE_MEAN_DB
}

/** ffmpeg's volumedetect reports on stderr; missing report = no audio = silent. */
export function parseMeanVolumeDb(ffmpegStderr: string): number {
  const match = ffmpegStderr.match(/mean_volume:\s*(-?[\d.]+)\s*dB/)
  return match ? Number(match[1]) : -Infinity
}

export async function measureMeanVolumeDb(wavPath: string): Promise<number> {
  const { stderr } = await execFileAsync(resolveBin('ffmpeg'), [
    '-i',
    wavPath,
    '-af',
    'volumedetect',
    '-f',
    'null',
    '-'
  ])
  return parseMeanVolumeDb(stderr)
}

export async function convertTo16k(srcWav: string, destWav: string): Promise<void> {
  await execFileAsync(resolveBin('ffmpeg'), [
    '-y',
    '-i',
    srcWav,
    '-ar',
    '16000',
    '-ac',
    '1',
    destWav
  ])
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
