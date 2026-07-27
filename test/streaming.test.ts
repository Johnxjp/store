import { describe, expect, it } from 'vitest'
import { findCutByte, peakDb, wrapWav } from '../experiments/streaming/streaming-transcriber'

const BYTES_PER_SECOND = 32000

function pcmOf(seconds: number, amplitude: number): Buffer {
  const buf = Buffer.alloc(seconds * BYTES_PER_SECOND)
  for (let i = 0; i < buf.length; i += 2) buf.writeInt16LE(amplitude, i)
  return buf
}

describe('wrapWav', () => {
  it('writes a valid 16 kHz mono s16le header', () => {
    const pcm = Buffer.alloc(1000)
    const wav = wrapWav(pcm)
    expect(wav.length).toBe(1044)
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE')
    expect(wav.readUInt32LE(24)).toBe(16000)
    expect(wav.readUInt16LE(22)).toBe(1)
    expect(wav.readUInt32LE(40)).toBe(1000)
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
    expect(findCutByte(buffered, 1, 0.5)).toBe(quietStart + 3200)
  })

  it('falls back to the window end when uniformly loud', () => {
    const buffered = pcmOf(1.2, 10000)
    const cut = findCutByte(buffered, 1, 0.5)
    expect(cut).toBeGreaterThan(0.5 * BYTES_PER_SECOND)
    expect(cut).toBeLessThanOrEqual(1 * BYTES_PER_SECOND)
  })
})
