import { appendFile, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { wrapWav } from '../src/main/chunker'
import { LiveTranscriber } from '../src/main/live'
import { convertTo16k, transcribeWav } from '../src/main/transcribe'

vi.mock('../src/main/transcribe', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/transcribe')>()),
  convertTo16k: vi.fn(async () => {}),
  transcribeWav: vi.fn(async () => [{ fromMs: 0, toMs: 500, text: 'hello' }])
}))

// chunkSeconds=1 with a 0.2s cut search and uniform amplitude gives fully
// deterministic cuts: the only candidate frame starts at 0.8s, so every full
// chunk is cut at 0.9s (frame midpoint).
const OPTS = { chunkSeconds: 1, cutSearchSeconds: 0.2 }

function tone(seconds: number, sampleRate: number, amplitude = 1000): Buffer {
  const buf = Buffer.alloc(Math.round(seconds * sampleRate) * 2)
  for (let i = 0; i < buf.length; i += 2) buf.writeInt16LE(amplitude, i)
  return buf
}

async function makeDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'live-test-'))
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(convertTo16k).mockImplementation(async () => {})
  vi.mocked(transcribeWav).mockImplementation(async () => [{ fromMs: 0, toMs: 500, text: 'hello' }])
})

describe('LiveTranscriber', () => {
  it('tail-reads growing WAVs, parses each stream sample rate, and offsets segment times', async () => {
    const dir = await makeDir()
    const live = new LiveTranscriber(dir, OPTS)

    // Files don't exist yet — the tick is a no-op and retries later.
    await live.tickOnce()

    await writeFile(join(dir, 'mic.wav'), wrapWav(tone(1.5, 16000), 16000))
    await writeFile(join(dir, 'system.wav'), wrapWav(tone(1.5, 48000), 48000))
    await live.tickOnce() // 1.5s buffered → chunk 0 cut at 0.9s

    await appendFile(join(dir, 'mic.wav'), tone(0.5, 16000))
    await appendFile(join(dir, 'system.wav'), tone(0.5, 48000))
    await live.tickOnce() // 1.1s buffered → chunk 1 cut at 0.9s (stream time 1.8s)

    const result = await live.finish() // flushes the 0.2s tail as chunk 2

    // Identical ms boundaries across a 16 kHz and a 48 kHz stream prove the
    // rate was parsed per stream; exact 0/900/1800 starts prove the byte
    // cursor read every appended byte exactly once.
    const expected = [
      { fromMs: 0, toMs: 500, text: 'hello' },
      { fromMs: 900, toMs: 1400, text: 'hello' },
      { fromMs: 1800, toMs: 2300, text: 'hello' }
    ]
    expect(result).toEqual({ mic: expected, system: expected })
    expect(transcribeWav).toHaveBeenCalledTimes(6)
  })

  it('skips silent chunks without transcribing them', async () => {
    const dir = await makeDir()
    const live = new LiveTranscriber(dir, OPTS)

    await writeFile(join(dir, 'mic.wav'), wrapWav(tone(1.5, 16000, 0), 16000))
    await writeFile(join(dir, 'system.wav'), wrapWav(tone(1.5, 48000), 48000))
    await live.tickOnce()
    const result = await live.finish()

    expect(result?.mic).toEqual([])
    expect(result?.system).toHaveLength(2)
    const paths = vi.mocked(transcribeWav).mock.calls.map(([p]) => p)
    expect(paths.every((p) => p.includes('system-'))).toBe(true)
  })

  it('invalidates on a transcribe failure and finish() resolves null without rejecting', async () => {
    vi.mocked(transcribeWav).mockRejectedValue(new Error('helper crashed'))
    const dir = await makeDir()
    const live = new LiveTranscriber(dir, OPTS)

    await writeFile(join(dir, 'mic.wav'), wrapWav(tone(1.5, 16000), 16000))
    await writeFile(join(dir, 'system.wav'), wrapWav(tone(0.1, 48000, 0), 48000))
    await live.tickOnce()

    await expect(live.finish()).resolves.toBeNull()
    // The first chunk's failure stops the queue — later chunks never transcribe.
    expect(transcribeWav).toHaveBeenCalledTimes(1)
  })

  it('notifies onChunk after each transcribed chunk', async () => {
    const dir = await makeDir()
    const onChunk = vi.fn()
    const live = new LiveTranscriber(dir, { ...OPTS, onChunk })

    await writeFile(join(dir, 'mic.wav'), wrapWav(tone(1.5, 16000), 16000))
    await writeFile(join(dir, 'system.wav'), wrapWav(tone(1.5, 48000, 0), 48000))
    await live.tickOnce()
    await live.finish()

    expect(onChunk).toHaveBeenCalledTimes(2) // mic chunks only; silent system chunks don't fire
  })

  it('cancel() is idempotent and makes finish() resolve null', async () => {
    const dir = await makeDir()
    const live = new LiveTranscriber(dir, OPTS)
    await writeFile(join(dir, 'mic.wav'), wrapWav(tone(1.5, 16000), 16000))
    await writeFile(join(dir, 'system.wav'), wrapWav(tone(1.5, 48000), 48000))
    live.start()
    live.cancel()
    live.cancel()
    await expect(live.finish()).resolves.toBeNull()
    expect(transcribeWav).not.toHaveBeenCalled()
  })

  // A pause is silence on both streams. The WAVs keep growing at real time, so
  // the chunk after one must still start at its true offset — if a skipped
  // chunk's duration went missing here, every timestamp after a pause would
  // slide earlier and the notes would point at the wrong moments.
  it('keeps segment offsets across a skipped silent chunk', async () => {
    const dir = await makeDir()
    const live = new LiveTranscriber(dir, OPTS)

    // 0.9s is exactly one chunk, so each piece lands in its own chunk:
    // tone, silence (the pause), tone.
    await writeFile(join(dir, 'mic.wav'), wrapWav(tone(0.9, 16000), 16000))
    await writeFile(join(dir, 'system.wav'), wrapWav(tone(0.9, 48000), 48000))
    await live.tickOnce()

    await appendFile(join(dir, 'mic.wav'), tone(0.9, 16000, 0))
    await appendFile(join(dir, 'system.wav'), tone(0.9, 48000, 0))
    await live.tickOnce() // 1.8s buffered -> chunk 0 (tone) cut at 0.9s

    await appendFile(join(dir, 'mic.wav'), tone(0.9, 16000))
    await appendFile(join(dir, 'system.wav'), tone(0.9, 48000))
    await live.tickOnce() // 1.8s buffered -> chunk 1 (the pause) cut at 0.9s

    const result = await live.finish() // flushes the tail tone as chunk 2

    // Chunk 1 (900-1800ms) never transcribes, yet chunk 2's segment still
    // starts at 1800ms rather than sliding up to 900ms.
    const expected = [
      { fromMs: 0, toMs: 500, text: 'hello' },
      { fromMs: 1800, toMs: 2300, text: 'hello' }
    ]
    expect(result).toEqual({ mic: expected, system: expected })

    const transcribed = vi
      .mocked(transcribeWav)
      .mock.calls.map(([path]) => basename(path))
      .sort()
    expect(transcribed).toEqual([
      'mic-0-16k.wav',
      'mic-2-16k.wav',
      'system-0-16k.wav',
      'system-2-16k.wav'
    ])
  })
})
