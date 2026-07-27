// Offline echo cancellation for an existing recording: removes speaker bleed
// from the mic stream using the system stream as the far-end reference
// (system.wav is exactly what the speakers played). Writes mic-16k-aec.wav
// next to the originals; does not touch existing files or transcripts.
// Usage: npx tsx experiments/offline-aec.ts [recording-dir]
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const dir = resolve(process.argv[2] ?? 'data/recordings/ba784f46-7a20-470c-9af5-5a3d96d9cd8c')
const session = JSON.parse(readFileSync(join(dir, 'session.json'), 'utf-8')) as {
  micEpochMs: number
  systemEpochMs: number
}

// Align the reference to the mic's timeline. The adaptive filter's taps can
// absorb the additional (positive) acoustic + device latency.
const delayMs = session.systemEpochMs - session.micEpochMs
if (delayMs < 0) throw new Error(`system started before mic (${delayMs} ms) — not handled`)

const micWav = join(dir, 'mic-16k.wav')
const systemWav = join(dir, 'system-16k.wav')
const outWav = join(dir, 'mic-16k-aec.wav')

// 2048 taps at 16 kHz = 128 ms of echo path after the epoch alignment.
// anlms out_mode=e emits the echo estimate (the part of the mic predictable
// from the reference) — verified empirically; the documented n/e modes do not
// behave as named. Cleaned mic = mic − estimate, done as an inverted mix.
const filter =
  `[0:a]asplit=2[micA][micB];` +
  `[1:a]adelay=${delayMs}[ref];` +
  `[ref][micA]anlms=order=2048:mu=0.75:out_mode=e[echo];` +
  `[echo]aeval=-val(0)[echoInv];` +
  `[micB][echoInv]amix=inputs=2:normalize=0[out]`

console.error(`aec: ref delay ${delayMs} ms, writing ${outWav}`)
const started = Date.now()
execFileSync('ffmpeg', [
  '-hide_banner',
  '-loglevel',
  'error',
  '-y',
  '-i',
  micWav,
  '-i',
  systemWav,
  '-filter_complex',
  filter,
  '-map',
  '[out]',
  '-c:a',
  'pcm_s16le',
  outWav
])
console.error(`aec: done in ${((Date.now() - started) / 1000).toFixed(0)}s`)

function levels(wav: string, ss: number, t: number): { meanDb: number; maxDb: number } {
  const result = spawnSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-ss',
      String(ss),
      '-t',
      String(t),
      '-i',
      wav,
      '-af',
      'volumedetect',
      '-f',
      'null',
      '-'
    ],
    { encoding: 'utf-8' }
  )
  const mean = result.stderr.match(/mean_volume:\s*(-?[\d.]+)/)
  const max = result.stderr.match(/max_volume:\s*(-?[\d.]+)/)
  return { meanDb: Number(mean?.[1] ?? NaN), maxDb: Number(max?.[1] ?? NaN) }
}

// Probe windows established in the bleed analysis (experiments/README.md §3):
// 2805s = far side only (pure bleed on the mic), 3791s = near side only.
const probes = [
  { label: 'bleed-only (far side speaking)', ss: 2805, t: 10 },
  { label: 'own voice (near side speaking)', ss: 3791, t: 9 }
].map((p) => ({
  ...p,
  before: levels(micWav, p.ss, p.t),
  after: levels(outWav, p.ss, p.t)
}))
console.log(JSON.stringify(probes, null, 2))
