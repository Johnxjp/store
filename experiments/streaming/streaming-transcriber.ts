// Chunked streaming transcription: accepts 16 kHz mono s16le PCM pushed in
// arbitrary-size buffers (as a live capture would deliver it), cuts ~30 s
// chunks at the quietest point near the boundary so words aren't split, and
// transcribes each chunk with whisper-cli as soon as it is complete.
//
// Cross-chunk context is preserved by passing the tail of the previous chunk's
// text as whisper's --prompt. Chunks whose peak level never rises above the
// app's silence gate are skipped entirely (whisper hallucinates on silence).
import { execFile } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { parseWhisperJson, resolveBin, SILENCE_MAX_DB } from '../../src/main/transcribe'
import type { WhisperSegment } from '../../src/main/merge'

const execFileAsync = promisify(execFile)

const SAMPLE_RATE = 16000
const BYTES_PER_SAMPLE = 2
const BYTES_PER_SECOND = SAMPLE_RATE * BYTES_PER_SAMPLE

export interface StreamingOptions {
  modelPath: string
  workDir: string
  /** Target chunk length before a cut is attempted. */
  chunkSeconds?: number
  /** The cut point is the quietest frame within this window before the chunk end. */
  cutSearchSeconds?: number
  /** Words of previous-chunk text passed to whisper as --prompt. 0 disables. */
  promptTailWords?: number
  onChunk?: (info: { index: number; startMs: number; endMs: number; text: string }) => void
}

export interface ChunkResult {
  index: number
  startMs: number
  endMs: number
  skippedAsSilent: boolean
  segments: WhisperSegment[]
}

export class StreamingTranscriber {
  private pending: Buffer[] = []
  private pendingBytes = 0
  private consumedBytes = 0
  private chunkIndex = 0
  private previousText = ''
  private queue: Promise<void> = Promise.resolve()
  readonly chunks: ChunkResult[] = []

  private readonly chunkSeconds: number
  private readonly cutSearchSeconds: number
  private readonly promptTailWords: number

  constructor(private readonly options: StreamingOptions) {
    this.chunkSeconds = options.chunkSeconds ?? 30
    this.cutSearchSeconds = options.cutSearchSeconds ?? 5
    this.promptTailWords = options.promptTailWords ?? 32
    mkdirSync(options.workDir, { recursive: true })
  }

  push(pcm: Buffer): void {
    this.pending.push(pcm)
    this.pendingBytes += pcm.length
    while (this.pendingBytes >= this.chunkSeconds * BYTES_PER_SECOND) {
      const buffered = Buffer.concat(this.pending)
      const cutByte = this.findCutByte(buffered)
      this.emitChunk(buffered.subarray(0, cutByte))
      this.pending = [buffered.subarray(cutByte)]
      this.pendingBytes = buffered.length - cutByte
    }
  }

  /** Flush trailing audio and wait for all queued transcriptions. */
  async finish(): Promise<ChunkResult[]> {
    if (this.pendingBytes > 0) {
      this.emitChunk(Buffer.concat(this.pending))
      this.pending = []
      this.pendingBytes = 0
    }
    await this.queue
    return this.chunks
  }

  private findCutByte(buffered: Buffer): number {
    return findCutByte(buffered, this.chunkSeconds, this.cutSearchSeconds)
  }

  private emitChunk(pcm: Buffer): void {
    const index = this.chunkIndex++
    const startMs = (this.consumedBytes / BYTES_PER_SECOND) * 1000
    this.consumedBytes += pcm.length
    const endMs = (this.consumedBytes / BYTES_PER_SECOND) * 1000
    this.queue = this.queue.then(() => this.transcribeChunk(index, startMs, endMs, pcm))
  }

  private async transcribeChunk(
    index: number,
    startMs: number,
    endMs: number,
    pcm: Buffer
  ): Promise<void> {
    if (peakDb(pcm) < SILENCE_MAX_DB) {
      this.chunks.push({ index, startMs, endMs, skippedAsSilent: true, segments: [] })
      return
    }
    const wavPath = join(this.options.workDir, `chunk-${String(index).padStart(3, '0')}.wav`)
    await writeFile(wavPath, wrapWav(pcm))
    const args = [
      '-m',
      this.options.modelPath,
      '-f',
      wavPath,
      '--output-json',
      '--output-file',
      wavPath.replace(/\.wav$/, ''),
      '--language',
      'en'
    ]
    if (this.promptTailWords > 0 && this.previousText) {
      args.push('--prompt', this.previousText.split(/\s+/).slice(-this.promptTailWords).join(' '))
    }
    await execFileAsync(resolveBin('whisper-cli'), args, { maxBuffer: 64 * 1024 * 1024 })
    const jsonPath = wavPath.replace(/\.wav$/, '.json')
    const raw = await readFile(jsonPath, 'utf-8')
    const segments = parseWhisperJson(raw).map((s) => ({
      ...s,
      fromMs: s.fromMs + startMs,
      toMs: s.toMs + startMs
    }))
    rmSync(wavPath)
    rmSync(jsonPath)
    const text = segments
      .map((s) => s.text.trim())
      .join(' ')
      .trim()
    if (text) this.previousText = text
    this.chunks.push({ index, startMs, endMs, skippedAsSilent: false, segments })
    this.options.onChunk?.({ index, startMs, endMs, text })
  }
}

/**
 * Quietest 200 ms frame in the last cutSearchSeconds of the target window, so
 * the cut lands in a pause rather than mid-word. Returns the byte offset of
 * that frame's midpoint (aligned to a sample boundary).
 */
export function findCutByte(
  buffered: Buffer,
  chunkSeconds: number,
  cutSearchSeconds: number
): number {
  const windowEnd = chunkSeconds * BYTES_PER_SECOND
  const searchStart = windowEnd - cutSearchSeconds * BYTES_PER_SECOND
  const frameBytes = 0.2 * BYTES_PER_SECOND
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
  return bestStart + frameBytes / 2
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

/** Minimal 44-byte PCM WAV header around raw s16le 16 kHz mono samples. */
export function wrapWav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(SAMPLE_RATE, 24)
  header.writeUInt32LE(BYTES_PER_SECOND, 28)
  header.writeUInt16LE(BYTES_PER_SAMPLE, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}
