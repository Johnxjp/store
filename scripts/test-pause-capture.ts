// Level 1 of docs/pause-and-resume-recording.md: drives the real audio-capture
// helper through a pause with real devices, then checks the two WAVs it wrote.
// Covers the two failures unit tests cannot reach: the zero-fill appending the
// wrong number of frames, so a WAV stops tracking wall clock and the streams
// slide apart, and audio reaching disk while paused.
//
// Usage: npx tsx scripts/test-pause-capture.ts [--pause-seconds N]
//          [--lead-seconds N] [--tail-seconds N] [--audio <file>]
//
// Needs a terminal that already holds the mic and system-audio grants; from a
// sandboxed shell capture just fails with no prompt (see CLAUDE.md). afplay
// covers the system stream for the whole run, but Apple's AEC removes it from
// the mic, so talk during the two recording windows or the mic's
// audio-outside-the-pause checks fail.
//
// The default pause is two minutes because a proportional frame-count error is
// invisible over five seconds.
import { execFile, spawn } from 'node:child_process'
import { mkdtemp, open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { parseWavSampleRate, peakDb } from '../src/main/chunker'
import { audioCaptureBin } from '../src/main/paths'
import { Recorder } from '../src/main/recorder'
import { isSilent, resolveBin, SILENCE_MAX_DB } from '../src/main/transcribe'

const execFileAsync = promisify(execFile)

const WAV_HEADER_BYTES = 44
/**
 * Absorbs the mic's dropped tail: the tap only delivers whole 4096-frame
 * buffers, so up to one buffer is lost at Stop (100 ms built-in, 256 ms on a
 * 16 kHz Bluetooth headset). A frame-count error in the zero-fill is
 * proportional to the pause, so over the default two minutes it lands far
 * outside this.
 */
export const DURATION_TOLERANCE_MS = 300
/**
 * Drift that hits both streams equally still breaks the merge, so they are
 * compared to each other too. Same tolerance: the dropped tail buffer shows up
 * here as the mic ending early.
 */
export const STREAM_SKEW_TOLERANCE_MS = 300
/** The gate takes effect within one buffer (~10 ms); this keeps boundary audio out of the measured windows. */
const GATE_GUARD_MS = 250
/** One 16-bit LSB is -90.3 dB, so only true zeros pass. */
export const PAUSED_MAX_DB = -90
/** Below this a window holds too little audio to say anything about it. */
const MIN_REGION_MS = 500

export interface CaptureStream {
  name: string
  wavPath: string
  /** Wall-clock ms of this stream's first audio buffer, from the helper's `started` event. */
  epochMs: number
}

export interface CaptureTiming {
  pauseStartMs: number
  pauseEndMs: number
  /**
   * Wall-clock ms at which `stop` was written to the helper. Measured on the
   * write, not on the exit that follows it: tearing the devices down takes
   * ~150 ms, which would show up as a constant shortfall in every stream.
   */
  stopSentMs: number
}

export interface Check {
  name: string
  ok: boolean
  detail: string
}

async function wavDurationMs(wavPath: string): Promise<number> {
  const { stdout } = await execFileAsync(resolveBin('ffprobe'), [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'csv=p=0',
    wavPath
  ])
  return Number(stdout.trim()) * 1000
}

/** Peak level over [fromMs, toMs) of a stream, read straight from the WAV's PCM. */
async function regionPeakDb(
  wavPath: string,
  fromMs: number,
  toMs: number
): Promise<{ peak: number; ms: number }> {
  const handle = await open(wavPath, 'r')
  try {
    const header = Buffer.alloc(WAV_HEADER_BYTES)
    await handle.read(header, 0, WAV_HEADER_BYTES, 0)
    const sampleRate = parseWavSampleRate(header)
    const { size } = await handle.stat()
    const byteAt = (ms: number): number =>
      Math.min(size, WAV_HEADER_BYTES + Math.max(0, Math.round((ms / 1000) * sampleRate)) * 2)
    const from = byteAt(fromMs)
    const to = byteAt(toMs)
    if (to <= from) return { peak: -Infinity, ms: 0 }
    const buf = Buffer.alloc(to - from)
    const { bytesRead } = await handle.read(buf, 0, buf.length, from)
    return { peak: peakDb(buf.subarray(0, bytesRead)), ms: (bytesRead / 2 / sampleRate) * 1000 }
  } finally {
    await handle.close()
  }
}

function formatDb(db: number): string {
  return Number.isFinite(db) ? `${db.toFixed(1)} dB` : 'digital silence'
}

/**
 * The four Level 1 checks, per stream plus one across the pair. Separate from
 * the capture above it so it can be exercised on synthetic WAVs, which is the
 * only way to prove these assertions fire.
 */
export async function analysePauseCapture(
  streams: CaptureStream[],
  timing: CaptureTiming
): Promise<Check[]> {
  const checks: Check[] = []
  const endsAt: Array<{ name: string; wallMs: number }> = []

  for (const stream of streams) {
    const durationMs = await wavDurationMs(stream.wavPath)
    const elapsedMs = timing.stopSentMs - stream.epochMs
    const drift = durationMs - elapsedMs
    checks.push({
      name: `${stream.name}: WAV length tracks wall clock`,
      ok: Math.abs(drift) <= DURATION_TOLERANCE_MS,
      detail:
        `${(durationMs / 1000).toFixed(3)}s recorded vs ${(elapsedMs / 1000).toFixed(3)}s elapsed ` +
        `(drift ${Math.round(drift)}ms, tolerance ${DURATION_TOLERANCE_MS}ms)`
    })
    endsAt.push({ name: stream.name, wallMs: stream.epochMs + durationMs })

    // Windows are converted to stream time: the two streams start at different epochs.
    const inStream = (wallMs: number): number => wallMs - stream.epochMs
    const windows = [
      {
        label: 'before the pause',
        fromMs: 0,
        toMs: inStream(timing.pauseStartMs) - GATE_GUARD_MS,
        wantSilent: false
      },
      {
        label: 'the paused window',
        fromMs: inStream(timing.pauseStartMs) + GATE_GUARD_MS,
        toMs: inStream(timing.pauseEndMs) - GATE_GUARD_MS,
        wantSilent: true
      },
      {
        label: 'after the pause',
        fromMs: inStream(timing.pauseEndMs) + GATE_GUARD_MS,
        toMs: durationMs,
        wantSilent: false
      }
    ]

    for (const window of windows) {
      const name = `${stream.name}: ${window.wantSilent ? 'silence across' : 'audio'} ${window.label}`
      const { peak, ms } = await regionPeakDb(stream.wavPath, window.fromMs, window.toMs)
      if (ms < MIN_REGION_MS) {
        checks.push({
          name,
          ok: false,
          detail: `only ${Math.round(ms)}ms to measure — the WAV is shorter than the run`
        })
        continue
      }
      checks.push({
        name,
        ok: window.wantSilent ? peak <= PAUSED_MAX_DB : !isSilent(peak),
        detail:
          `peak ${formatDb(peak)} over ${(ms / 1000).toFixed(1)}s ` +
          (window.wantSilent
            ? `(must sit at the 16-bit floor, ${PAUSED_MAX_DB} dB or below)`
            : `(must rise above ${SILENCE_MAX_DB} dB)`)
      })
    }
  }

  if (endsAt.length === 2) {
    const skew = endsAt[0].wallMs - endsAt[1].wallMs
    checks.push({
      name: 'the two streams agree with each other',
      ok: Math.abs(skew) <= STREAM_SKEW_TOLERANCE_MS,
      detail:
        `${endsAt[0].name} ends ${Math.abs(Math.round(skew))}ms ` +
        `${skew >= 0 ? 'after' : 'before'} ${endsAt[1].name} ` +
        `(tolerance ${STREAM_SKEW_TOLERANCE_MS}ms)`
    })
  }
  return checks
}

interface Options {
  pauseSeconds: number
  leadSeconds: number
  tailSeconds: number
  audioFile: string
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    pauseSeconds: 120,
    leadSeconds: 15,
    tailSeconds: 15,
    audioFile: '/System/Library/Sounds/Submarine.aiff'
  }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--pause-seconds') options.pauseSeconds = Number(argv[++i])
    else if (argv[i] === '--lead-seconds') options.leadSeconds = Number(argv[++i])
    else if (argv[i] === '--tail-seconds') options.tailSeconds = Number(argv[++i])
    else if (argv[i] === '--audio') options.audioFile = argv[++i]
    else {
      console.error(`unknown argument: ${argv[i]}`)
      process.exit(1)
    }
  }
  return options
}

/**
 * afplay has no loop flag, so a shell loop stands in for one. It runs for the
 * whole capture: during the pause it gives the system-audio gate a real signal
 * to reject, and outside it supplies the audio the system stream must contain.
 */
function startAudioLoop(audioFile: string): () => void {
  const child = spawn('/bin/sh', ['-c', 'while :; do afplay "$1"; done', 'sh', audioFile], {
    detached: true,
    stdio: 'ignore'
  })
  // Its own process group, so the kill takes the afplay child with it.
  return () => {
    if (child.pid) {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        // already gone
      }
    }
  }
}

async function capture(
  options: Options,
  dir: string
): Promise<{ streams: CaptureStream[]; timing: CaptureTiming }> {
  const recorder = new Recorder(audioCaptureBin)
  const stopAudio = startAudioLoop(options.audioFile)
  try {
    const anchors = await recorder.start(dir)
    console.log(`recording for ${options.leadSeconds}s — talk now`)
    await delay(options.leadSeconds * 1000)

    recorder.pause()
    const pauseStartMs = Date.now()
    console.log(`paused for ${options.pauseSeconds}s — say things that must not be recorded`)
    await delay(options.pauseSeconds * 1000)

    recorder.resume()
    const pauseEndMs = Date.now()
    console.log(`resumed for ${options.tailSeconds}s — talk again`)
    await delay(options.tailSeconds * 1000)

    const stopSentMs = Date.now()
    await recorder.stop()
    return {
      streams: [
        { name: 'mic', wavPath: join(dir, 'mic.wav'), epochMs: anchors.micEpochMs },
        { name: 'system', wavPath: join(dir, 'system.wav'), epochMs: anchors.systemEpochMs }
      ],
      timing: { pauseStartMs, pauseEndMs, stopSentMs }
    }
  } finally {
    stopAudio()
    if (recorder.isRecording) await recorder.stop().catch(() => {})
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const dir = await mkdtemp(join(tmpdir(), 'pause-capture-'))
  console.log(`recording into ${dir}`)

  const { streams, timing } = await capture(options, dir)
  const checks = await analysePauseCapture(streams, timing)

  console.log('')
  for (const check of checks) {
    console.log(`${check.ok ? 'PASS' : 'FAIL'}  ${check.name} — ${check.detail}`)
  }
  const failed = checks.filter((check) => !check.ok).length
  console.log('')
  console.log(`${checks.length - failed}/${checks.length} checks passed · WAVs kept in ${dir}`)
  if (failed > 0) process.exitCode = 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
