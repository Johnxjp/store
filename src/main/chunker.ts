// Pure PCM chunking for live transcription: accumulates s16le mono samples
// and cuts ~chunkSeconds pieces at the quietest instant near the boundary so
// words aren't split. No I/O — callers own reading audio and transcribing.

const BYTES_PER_SAMPLE = 2
const CUT_FRAME_SECONDS = 0.2

export interface PcmChunk {
  index: number
  startMs: number
  endMs: number
  pcm: Buffer
}

/**
 * Quietest 200 ms frame in the last cutSearchSeconds of the target window, so
 * the cut lands in a pause rather than mid-word. Returns the byte offset of
 * that frame's midpoint (floored to a 2-byte sample boundary).
 */
export function findCutByte(
  buffered: Buffer,
  chunkSeconds: number,
  cutSearchSeconds: number,
  bytesPerSecond: number
): number {
  const toSample = (n: number) => Math.floor(n / BYTES_PER_SAMPLE) * BYTES_PER_SAMPLE
  const windowEnd = toSample(chunkSeconds * bytesPerSecond)
  const searchStart = toSample(windowEnd - cutSearchSeconds * bytesPerSecond)
  const frameBytes = toSample(CUT_FRAME_SECONDS * bytesPerSecond)
  let bestStart = windowEnd - frameBytes
  let bestEnergy = Infinity
  for (let start = searchStart; start + frameBytes <= windowEnd; start += frameBytes) {
    let energy = 0
    for (let i = start; i < start + frameBytes; i += BYTES_PER_SAMPLE) {
      const sample = buffered.readInt16LE(i)
      energy += sample * sample
    }
    if (energy < bestEnergy) {
      bestEnergy = energy
      bestStart = start
    }
  }
  return toSample(bestStart + frameBytes / 2)
}

export function peakDb(pcm: Buffer): number {
  let peak = 0
  for (let i = 0; i + BYTES_PER_SAMPLE <= pcm.length; i += BYTES_PER_SAMPLE) {
    const sample = Math.abs(pcm.readInt16LE(i))
    if (sample > peak) peak = sample
  }
  if (peak === 0) return -Infinity
  return 20 * Math.log10(peak / 32768)
}

/** Minimal 44-byte PCM WAV header around raw s16le mono samples. */
export function wrapWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * BYTES_PER_SAMPLE, 28)
  header.writeUInt16LE(BYTES_PER_SAMPLE, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

/** Reads the sample rate from a canonical WAV header (fmt chunk at offset 12). */
export function parseWavSampleRate(header: Buffer): number {
  if (
    header.length < 28 ||
    header.toString('ascii', 0, 4) !== 'RIFF' ||
    header.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    throw new Error('not a WAV header')
  }
  return header.readUInt32LE(24)
}

/** Accumulates pushed PCM and returns completed chunks; flush() drains the tail. */
export class PcmChunker {
  private pending: Buffer[] = []
  private pendingBytes = 0
  private consumedBytes = 0
  private chunkIndex = 0
  private readonly bytesPerSecond: number

  constructor(
    sampleRate: number,
    private readonly chunkSeconds = 30,
    private readonly cutSearchSeconds = 5
  ) {
    this.bytesPerSecond = sampleRate * BYTES_PER_SAMPLE
  }

  push(pcm: Buffer): PcmChunk[] {
    this.pending.push(pcm)
    this.pendingBytes += pcm.length
    const out: PcmChunk[] = []
    while (this.pendingBytes >= this.chunkSeconds * this.bytesPerSecond) {
      const buffered = Buffer.concat(this.pending)
      const cutByte = findCutByte(
        buffered,
        this.chunkSeconds,
        this.cutSearchSeconds,
        this.bytesPerSecond
      )
      out.push(this.emit(buffered.subarray(0, cutByte)))
      this.pending = [buffered.subarray(cutByte)]
      this.pendingBytes = buffered.length - cutByte
    }
    return out
  }

  flush(): PcmChunk[] {
    if (this.pendingBytes === 0) return []
    const chunk = this.emit(Buffer.concat(this.pending))
    this.pending = []
    this.pendingBytes = 0
    return [chunk]
  }

  private emit(pcm: Buffer): PcmChunk {
    const index = this.chunkIndex++
    const startMs = (this.consumedBytes / this.bytesPerSecond) * 1000
    this.consumedBytes += pcm.length
    const endMs = (this.consumedBytes / this.bytesPerSecond) * 1000
    return { index, startMs, endMs, pcm }
  }
}
