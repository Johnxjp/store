import { describe, expect, it } from 'vitest'
import { findCutByte, parseWavSampleRate, peakDb, PcmChunker, wrapWav } from '../src/main/chunker'

const BYTES_PER_SECOND = 32000

function pcmOf(seconds: number, amplitude: number, bytesPerSecond = BYTES_PER_SECOND): Buffer {
  const buf = Buffer.alloc(seconds * bytesPerSecond)
  for (let i = 0; i < buf.length; i += 2) buf.writeInt16LE(amplitude, i)
  return buf
}

describe('wrapWav', () => {
  it('writes a valid 16 kHz mono s16le header', () => {
    const pcm = Buffer.alloc(1000)
    const wav = wrapWav(pcm, 16000)
    expect(wav.length).toBe(1044)
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE')
    expect(wav.readUInt32LE(24)).toBe(16000)
    expect(wav.readUInt16LE(22)).toBe(1)
    expect(wav.readUInt32LE(40)).toBe(1000)
  })

  it('writes the requested sample rate and byte rate', () => {
    const wav = wrapWav(Buffer.alloc(100), 48000)
    expect(wav.readUInt32LE(24)).toBe(48000)
    expect(wav.readUInt32LE(28)).toBe(96000)
  })
})

describe('parseWavSampleRate', () => {
  it('reads the rate back from a generated header', () => {
    expect(parseWavSampleRate(wrapWav(Buffer.alloc(10), 48000))).toBe(48000)
    expect(parseWavSampleRate(wrapWav(Buffer.alloc(10), 16000))).toBe(16000)
  })

  it('throws on garbage', () => {
    expect(() => parseWavSampleRate(Buffer.from('not a wav file, honest'))).toThrow()
    expect(() => parseWavSampleRate(Buffer.alloc(4))).toThrow()
  })
})

describe('peakDb', () => {
  it('is 0 dB at full scale and -Infinity on digital silence', () => {
    expect(peakDb(pcmOf(0.01, 32767))).toBeCloseTo(0, 1)
    expect(peakDb(pcmOf(0.01, 0))).toBe(-Infinity)
  })

  it('is around -6 dB at half scale', () => {
    expect(peakDb(pcmOf(0.01, 16384))).toBeCloseTo(-6, 0)
  })
})

describe('findCutByte', () => {
  it('cuts at the quietest frame in the search window', () => {
    const buffered = pcmOf(1.2, 10000)
    const quietStart = 22400
    for (let i = quietStart; i < quietStart + 6400; i += 2) buffered.writeInt16LE(0, i)
    expect(findCutByte(buffered, 1, 0.5, 32000)).toBe(quietStart + 3200)
  })

  it('falls back to the window end when uniformly loud', () => {
    const buffered = pcmOf(1.2, 10000)
    const cut = findCutByte(buffered, 1, 0.5, 32000)
    expect(cut).toBeGreaterThan(0.5 * BYTES_PER_SECOND)
    expect(cut).toBeLessThanOrEqual(1 * BYTES_PER_SECOND)
  })

  it('returns sample-aligned offsets at 96,000 and 44,100 B/s', () => {
    for (const bps of [96_000, 44_100]) {
      const cut = findCutByte(Buffer.alloc(1.2 * bps), 1, 0.5, bps)
      expect(cut % 2).toBe(0)
      expect(cut).toBeGreaterThan(0.5 * bps - bps * 0.2)
      expect(cut).toBeLessThanOrEqual(bps)
    }
  })
})

describe('PcmChunker', () => {
  // 16 kHz for readable numbers: 32,000 B/s, 1 s chunks, 0.5 s cut search.
  const chunker = () => new PcmChunker(16000, 1, 0.5)

  it('emits nothing until a full chunk has accumulated', () => {
    const c = chunker()
    expect(c.push(pcmOf(0.4, 100))).toEqual([])
    expect(c.push(pcmOf(0.4, 100))).toEqual([])
  })

  it('emits a chunk with correct timings once the threshold is crossed', () => {
    const c = chunker()
    expect(c.push(pcmOf(0.9, 10000))).toEqual([])
    const chunks = c.push(pcmOf(0.3, 10000))
    expect(chunks).toHaveLength(1)
    expect(chunks[0].index).toBe(0)
    expect(chunks[0].startMs).toBe(0)
    expect(chunks[0].endMs).toBeCloseTo((chunks[0].pcm.length / 32000) * 1000, 5)
  })

  it('emits several chunks from one large push', () => {
    const chunks = chunker().push(pcmOf(3.5, 10000))
    expect(chunks.length).toBeGreaterThanOrEqual(3)
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i))
  })

  it('flush returns the tail and byte accounting is exact across cuts', () => {
    const c = chunker()
    const pushed = [pcmOf(0.7, 5000), pcmOf(0.7, 5000), pcmOf(0.7, 5000)]
    const emitted = pushed.flatMap((p) => c.push(p))
    const tail = c.flush()
    expect(tail).toHaveLength(1)
    expect(c.flush()).toEqual([])

    const all = [...emitted, ...tail]
    const totalPushed = pushed.reduce((n, p) => n + p.length, 0)
    const totalEmitted = all.reduce((n, ch) => n + ch.pcm.length, 0)
    expect(totalEmitted).toBe(totalPushed)
    for (let i = 1; i < all.length; i++) {
      expect(all[i].startMs).toBeCloseTo(all[i - 1].endMs, 5)
    }
    expect(all[all.length - 1].endMs).toBeCloseTo((totalPushed / 32000) * 1000, 5)
  })
})
