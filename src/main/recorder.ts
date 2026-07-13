import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'

export interface RecorderAnchors {
  micEpochMs: number
  systemEpochMs: number
}

interface HelperEvent {
  event: 'started' | 'stopped' | 'error'
  micEpochMs?: number
  systemEpochMs?: number
  durationMs?: number
  message?: string
}

/**
 * Wraps one run of the audio-capture Swift helper: capture starts on spawn,
 * stops when "stop" is written to its stdin.
 */
export class Recorder {
  private child: ChildProcessByStdio<Writable, Readable, Readable> | null = null
  private stopped: Promise<number> | null = null

  constructor(private readonly helperPath: string) {}

  get isRecording(): boolean {
    return this.child !== null
  }

  /** Spawns the helper; resolves with epoch anchors once both streams deliver audio. */
  start(recordingDir: string): Promise<RecorderAnchors> {
    if (this.child) throw new Error('already recording')
    const child = spawn(this.helperPath, ['--dir', recordingDir], {
      stdio: ['pipe', 'pipe', 'pipe']
    })
    this.child = child

    let resolveStopped!: (durationMs: number) => void
    this.stopped = new Promise((r) => (resolveStopped = r))

    return new Promise<RecorderAnchors>((resolve, reject) => {
      const rl = createInterface({ input: child.stdout })
      let started = false
      let durationMs = 0

      rl.on('line', (line) => {
        let ev: HelperEvent
        try {
          ev = JSON.parse(line) as HelperEvent
        } catch {
          return
        }
        if (ev.event === 'started' && ev.micEpochMs && ev.systemEpochMs) {
          started = true
          resolve({ micEpochMs: ev.micEpochMs, systemEpochMs: ev.systemEpochMs })
        } else if (ev.event === 'stopped') {
          durationMs = ev.durationMs ?? 0
        } else if (ev.event === 'error') {
          if (!started) reject(new Error(ev.message ?? 'audio capture failed'))
        }
      })

      child.on('error', (err) => {
        this.child = null
        if (!started) reject(err)
      })
      child.on('exit', (code) => {
        this.child = null
        if (!started) reject(new Error(`audio-capture exited early (code ${code})`))
        resolveStopped(durationMs)
      })
    })
  }

  /** Asks the helper to stop and waits for it to finalize the WAVs. */
  async stop(): Promise<number> {
    const child = this.child
    if (!child || !this.stopped) throw new Error('not recording')
    child.stdin.write('stop\n')
    const timeout = new Promise<number>((_, rej) =>
      setTimeout(() => rej(new Error('audio-capture did not stop within 10s')), 10_000)
    )
    return Promise.race([this.stopped, timeout])
  }
}
