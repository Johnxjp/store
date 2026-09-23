import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Recorder } from '../src/main/recorder'

// Stands in for the Swift helper: emits the `started` event that
// Recorder.start() waits on, logs every stdin line it is handed, and exits on
// `stop`. No microphone and no TCC grant involved, so CI runs this too.
const STUB_HELPER = `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const dir = process.argv[process.argv.indexOf('--dir') + 1]
const emit = (event) => JSON.stringify(event) + '\\n'

process.stdout.write(
  emit({ event: 'started', micFile: 'mic.wav', systemFile: 'system.wav', micEpochMs: 1000, systemEpochMs: 1500 })
)

createInterface({ input: process.stdin }).on('line', (line) => {
  appendFileSync(dir + '/stdin-lines.txt', line + '\\n')
  // stdout is a pipe, so exiting before the write drains loses the event.
  if (line === 'stop') process.stdout.write(emit({ event: 'stopped', durationMs: 4242 }), () => process.exit(0))
})
`

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const clean of cleanups.splice(0)) await clean()
})

interface Stub {
  recorder: Recorder
  dir: string
  /** Lines the helper has received so far, in order. */
  lines: () => Promise<string[]>
  /** Resolves once the helper has logged at least `count` lines. */
  waitForLines: (count: number) => Promise<string[]>
}

async function stubHelper(): Promise<Stub> {
  const dir = await mkdtemp(join(tmpdir(), 'recorder-test-'))
  const helperPath = join(dir, 'stub-helper.mjs')
  await writeFile(helperPath, STUB_HELPER)
  await chmod(helperPath, 0o755)
  const recorder = new Recorder(helperPath)
  cleanups.push(async () => {
    if (recorder.isRecording) await recorder.stop().catch(() => {})
    await rm(dir, { recursive: true, force: true })
  })

  const lines = async (): Promise<string[]> => {
    const raw = await readFile(join(dir, 'stdin-lines.txt'), 'utf-8').catch(() => '')
    return raw.split('\n').filter((line) => line.length > 0)
  }
  // The helper is another process writing a file, so there is no in-process
  // signal to await; poll it rather than guess at a sleep length.
  const waitForLines = async (count: number): Promise<string[]> => {
    const deadline = Date.now() + 4000
    for (;;) {
      const current = await lines()
      if (current.length >= count) return current
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${count} lines, got [${current.join(', ')}]`)
      }
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }
  return { recorder, dir, lines, waitForLines }
}

describe('Recorder pause and resume', () => {
  it('writes pause and resume lines to the helper, in order', async () => {
    const { recorder, dir, waitForLines } = await stubHelper()

    await expect(recorder.start(dir)).resolves.toEqual({ micEpochMs: 1000, systemEpochMs: 1500 })
    expect(recorder.isPaused).toBe(false)

    recorder.pause()
    expect(recorder.isPaused).toBe(true)
    expect(await waitForLines(1)).toEqual(['pause'])

    recorder.resume()
    expect(recorder.isPaused).toBe(false)
    expect(await waitForLines(2)).toEqual(['pause', 'resume'])
  })

  it('treats a repeated pause or resume as a no-op', async () => {
    const { recorder, dir, waitForLines } = await stubHelper()
    await recorder.start(dir)

    recorder.pause()
    await waitForLines(1)
    recorder.pause()
    expect(recorder.isPaused).toBe(true)

    recorder.resume()
    recorder.resume()
    recorder.pause()

    // A duplicate line would land between these, so the exact sequence is the
    // proof that neither repeat reached the helper.
    expect(await waitForLines(3)).toEqual(['pause', 'resume', 'pause'])
  })

  it('throws when nothing is recording', async () => {
    const { recorder, dir } = await stubHelper()
    expect(() => recorder.pause()).toThrow('not recording')
    expect(() => recorder.resume()).toThrow('not recording')

    await recorder.start(dir)
    await recorder.stop()
    expect(() => recorder.pause()).toThrow('not recording')
  })

  it('stops cleanly while paused', async () => {
    const { recorder, dir, lines, waitForLines } = await stubHelper()
    await recorder.start(dir)

    recorder.pause()
    await waitForLines(1)

    // stop() only resolves on the helper's exit, so this is the exit proof.
    await expect(recorder.stop()).resolves.toBeTypeOf('number')
    expect(recorder.isRecording).toBe(false)
    expect(await lines()).toEqual(['pause', 'stop'])
  })
})
