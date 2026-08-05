import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as db from '../src/main/db'
import { runPipeline } from '../src/main/pipeline'
import { generateNotes } from '../src/main/enhance'
import { transcribeWav } from '../src/main/transcribe'

vi.mock('../src/main/transcribe', () => ({
  convertTo16k: vi.fn(async () => {}),
  measureMaxVolumeDb: vi.fn(async () => -20),
  isSilent: vi.fn(() => false),
  boostGainDb: vi.fn(() => 0),
  transcribeWav: vi.fn(async () => [{ fromMs: 0, toMs: 1000, text: 'we shipped the release' }])
}))

vi.mock('../src/main/enhance', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/enhance')>()),
  generateNotes: vi.fn(async () => '## Notes')
}))

vi.mock('../src/main/config', () => ({
  readConfig: vi.fn(() => ({
    ollamaModel: 'test-model',
    ollamaUrl: 'http://localhost:11434',
    numCtx: 32_768,
    maxTranscriptChars: 110_000
  }))
}))

async function createMeetingWithAudioDir(id: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pipeline-test-'))
  await writeFile(join(dir, 'session.json'), JSON.stringify({ micEpochMs: 0, systemEpochMs: 0 }))
  db.createMeeting({ id, title: 'Standup', audioDir: dir, startedAt: 1000 })
  return dir
}

beforeEach(() => {
  db.initDb(':memory:')
  vi.clearAllMocks()
})

describe('runPipeline', () => {
  it('runs the full pipeline when no transcript exists', async () => {
    await createMeetingWithAudioDir('m1')

    await runPipeline('m1', () => {})

    expect(transcribeWav).toHaveBeenCalledTimes(2)
    expect(db.getTranscript('m1').length).toBeGreaterThan(0)
    expect(db.getMeeting('m1')).toMatchObject({ status: 'ready', enhancedNotes: '## Notes' })
  })

  it('resumes at summarization when a transcript is already stored', async () => {
    await createMeetingWithAudioDir('m1')
    db.saveTranscript('m1', [{ speaker: 'me', startMs: 0, endMs: 1000, text: 'hello' }])
    db.setMeetingStatus('m1', 'error', 'Ollama fell over')

    await runPipeline('m1', () => {})

    expect(transcribeWav).not.toHaveBeenCalled()
    expect(generateNotes).toHaveBeenCalledTimes(1)
    expect(db.getMeeting('m1')).toMatchObject({ status: 'ready', enhancedNotes: '## Notes' })
  })

  it('marks the meeting error when transcription cannot start', async () => {
    db.createMeeting({ id: 'm1', title: 'Standup', audioDir: '/nonexistent', startedAt: 1000 })

    await expect(runPipeline('m1', () => {})).rejects.toThrow()
    expect(db.getMeeting('m1')?.status).toBe('error')
  })
})
