// Live transcription: while a meeting records, tail-read the two growing WAV
// files, cut the new audio into ~30s chunks and transcribe each one with the
// existing fluid-transcribe helper, so at Stop only the final partial chunk
// remains. Purely additive to the batch pipeline: any failure invalidates the
// session and finish() resolves null, which sends the pipeline down today's
// batch path from the untouched WAVs. Segments stay in main-process memory —
// this module never touches the database, so a partial transcript
// structurally cannot be persisted.
import { mkdir, open, unlink, writeFile, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { parseWavSampleRate, peakDb, PcmChunker, wrapWav, type PcmChunk } from './chunker'
import type { StreamSegment } from './merge'
import { boostGainDb, convertTo16k, isSilent, transcribeWav } from './transcribe'

const WAV_HEADER_BYTES = 44
const TICK_INTERVAL_MS = 5000
const DEFAULT_CHUNK_SECONDS = 30
const DEFAULT_CUT_SEARCH_SECONDS = 5

export interface LiveSegments {
  mic: StreamSegment[]
  system: StreamSegment[]
}

export interface LiveTranscriberOptions {
  chunkSeconds?: number
  cutSearchSeconds?: number
  /** Fires after a chunk finishes transcribing (the cache warmer's hook). */
  onChunk?: () => void
}

type StreamName = keyof LiveSegments

interface StreamState {
  name: StreamName
  wavPath: string
  handle: FileHandle | null
  /** Next unread byte in the WAV. The data region is append-only, so reading from here never re-reads or skips audio. */
  cursor: number
  chunker: PcmChunker | null
  sampleRate: number
  segments: StreamSegment[]
  /** Chunks transcribe sequentially per stream; one rejection invalidates the whole session. */
  queue: Promise<void>
}

export class LiveTranscriber {
  private readonly streams: StreamState[]
  private readonly liveDir: string
  private readonly chunkSeconds: number
  private readonly cutSearchSeconds: number
  private readonly onChunk?: () => void
  private interval: NodeJS.Timeout | null = null
  private tickChain: Promise<void> = Promise.resolve()
  private invalidated = false
  private stopped = false

  constructor(recordingDir: string, options: LiveTranscriberOptions = {}) {
    this.liveDir = join(recordingDir, 'live')
    this.chunkSeconds = options.chunkSeconds ?? DEFAULT_CHUNK_SECONDS
    this.cutSearchSeconds = options.cutSearchSeconds ?? DEFAULT_CUT_SEARCH_SECONDS
    this.onChunk = options.onChunk
    this.streams = (['mic', 'system'] as const).map((name) => ({
      name,
      wavPath: join(recordingDir, `${name}.wav`),
      handle: null,
      cursor: 0,
      chunker: null,
      sampleRate: 0,
      segments: [],
      queue: Promise.resolve()
    }))
  }

  start(): void {
    if (this.interval || this.stopped) return
    this.interval = setInterval(() => {
      this.tickChain = this.tickChain.then(() => this.tickOnce())
    }, TICK_INTERVAL_MS)
  }

  /** One read-and-chunk pass over both streams. Public so tests and the replay harness can drive it without timers. Never rejects. */
  async tickOnce(): Promise<void> {
    if (this.invalidated || this.stopped) return
    try {
      await Promise.all(this.streams.map((s) => this.readNewAudio(s)))
    } catch (err) {
      this.invalidate(err)
    }
  }

  /** The segments transcribed so far (for the cache warmer). */
  snapshot(): LiveSegments {
    const byName = (name: StreamName): StreamSegment[] =>
      this.streams.find((s) => s.name === name)!.segments.slice()
    return { mic: byName('mic'), system: byName('system') }
  }

  /**
   * Stops ticking, reads the streams to EOF (the WAVs must be finalized by
   * now), transcribes the tail chunks and resolves the full per-stream
   * segments — or null if the session was invalidated. Never rejects.
   */
  async finish(): Promise<LiveSegments | null> {
    this.stopTicking()
    await this.tickChain
    this.stopped = true
    if (!this.invalidated) {
      try {
        await Promise.all(this.streams.map((s) => this.readNewAudio(s)))
        for (const stream of this.streams) {
          for (const chunk of stream.chunker?.flush() ?? []) this.enqueueChunk(stream, chunk)
        }
      } catch (err) {
        this.invalidate(err)
      }
    }
    await Promise.all(this.streams.map((s) => s.queue))
    await this.closeHandles()
    return this.invalidated ? null : this.snapshot()
  }

  /** Idempotent teardown for quit/error paths: stop ticking, drop everything. */
  cancel(): void {
    this.invalidated = true
    this.stopped = true
    this.stopTicking()
    void this.closeHandles()
  }

  private async readNewAudio(stream: StreamState): Promise<void> {
    if (!stream.handle) {
      try {
        stream.handle = await open(stream.wavPath, 'r')
      } catch {
        return // not created yet — retry next tick (finish() reads a complete file in one pass)
      }
    }
    if (!stream.chunker) {
      const header = Buffer.alloc(WAV_HEADER_BYTES)
      const { bytesRead } = await stream.handle.read(header, 0, WAV_HEADER_BYTES, 0)
      if (bytesRead < WAV_HEADER_BYTES) return
      stream.sampleRate = parseWavSampleRate(header)
      stream.chunker = new PcmChunker(stream.sampleRate, this.chunkSeconds, this.cutSearchSeconds)
      stream.cursor = WAV_HEADER_BYTES
    }
    // The writer keeps the header's size field lagging; stat is the truth.
    const { size } = await stream.handle.stat()
    if (size <= stream.cursor) return
    const buf = Buffer.alloc(size - stream.cursor)
    const { bytesRead } = await stream.handle.read(buf, 0, buf.length, stream.cursor)
    stream.cursor += bytesRead
    for (const chunk of stream.chunker.push(buf.subarray(0, bytesRead))) {
      this.enqueueChunk(stream, chunk)
    }
  }

  private enqueueChunk(stream: StreamState, chunk: PcmChunk): void {
    stream.queue = stream.queue
      .then(async () => {
        if (this.invalidated) return
        await this.processChunk(stream, chunk)
      })
      .catch((err) => this.invalidate(err))
  }

  private async processChunk(stream: StreamState, chunk: PcmChunk): Promise<void> {
    const label = `${stream.name} chunk ${chunk.index}`
    const seconds = ((chunk.endMs - chunk.startMs) / 1000).toFixed(1)
    const peak = peakDb(chunk.pcm)
    if (isSilent(peak)) {
      console.log(`[live] ${label} (${seconds}s) silent — skipped`)
      return
    }
    const base = join(this.liveDir, `${stream.name}-${chunk.index}`)
    const rawWav = `${base}.wav`
    const wav16k = `${base}-16k.wav`
    await mkdir(this.liveDir, { recursive: true })
    await writeFile(rawWav, wrapWav(chunk.pcm, stream.sampleRate))
    await convertTo16k(rawWav, wav16k, boostGainDb(peak))
    const started = Date.now()
    const segments = await transcribeWav(wav16k)
    for (const s of segments) {
      stream.segments.push({
        fromMs: Math.round(s.fromMs + chunk.startMs),
        toMs: Math.round(s.toMs + chunk.startMs),
        text: s.text
      })
    }
    console.log(
      `[live] ${label} (${seconds}s) → ${segments.length} segments in ` +
        `${((Date.now() - started) / 1000).toFixed(1)}s`
    )
    // Only successful chunks clean up; failures keep their files for debugging.
    const jsonPath = wav16k.replace(/\.wav$/, '.json')
    await Promise.all([rawWav, wav16k, jsonPath].map((f) => unlink(f).catch(() => {})))
    this.onChunk?.()
  }

  private invalidate(err: unknown): void {
    if (this.invalidated) return
    this.invalidated = true
    this.stopTicking()
    console.error('[live] invalidated — the pipeline will fall back to batch transcription:', err)
  }

  private stopTicking(): void {
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = null
    }
  }

  private async closeHandles(): Promise<void> {
    for (const stream of this.streams) {
      const handle = stream.handle
      stream.handle = null
      if (handle) await handle.close().catch(() => {})
    }
  }
}
