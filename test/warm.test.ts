import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { ChatPrompt } from '../src/main/enhance'
import { SummaryWarmer } from '../src/main/warm'

type FetchFn = (url: string, init: RequestInit) => Promise<Response>

const asDeps = (fetchFn: Mock<FetchFn>) => ({ fetchFn: fetchFn as unknown as typeof fetch })

vi.mock('../src/main/config', () => ({
  readConfig: vi.fn(() => ({
    ollamaModel: 'test-model',
    ollamaUrl: 'http://ollama.test',
    numCtx: 32_768,
    maxTranscriptChars: 110_000,
    liveTranscription: true
  }))
}))

function prompt(user: string): ChatPrompt {
  return { system: 'instructions', user }
}

function okResponse(): Response {
  return { ok: true, json: async () => ({ prompt_eval_count: 42 }) } as unknown as Response
}

function sentBody(fetchFn: Mock<FetchFn>, call: number): Record<string, unknown> {
  return JSON.parse(fetchFn.mock.calls[call][1].body as string) as Record<string, unknown>
}

/** Long enough for any wrongly-issued follow-up request to have landed. */
const settle = () => new Promise((r) => setTimeout(r, 20))

beforeEach(() => {
  vi.clearAllMocks()
})

describe('SummaryWarmer', () => {
  it('sends one request with the current prompt on an idle poke', async () => {
    const fetchFn = vi.fn<FetchFn>(async () => okResponse())
    const warmer = new SummaryWarmer(() => prompt('transcript v1'), asDeps(fetchFn))

    warmer.poke()
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1))

    expect(fetchFn.mock.calls[0][0]).toBe('http://ollama.test/api/chat')
    const body = sentBody(fetchFn, 0)
    expect(body).toMatchObject({
      model: 'test-model',
      stream: false,
      keep_alive: '15m',
      options: { temperature: 0, num_ctx: 32_768, num_predict: 1 },
      messages: [
        { role: 'system', content: 'instructions' },
        { role: 'user', content: 'transcript v1' }
      ]
    })
  })

  it('coalesces pokes during a warm into exactly one follow-up with the latest prompt', async () => {
    let version = 1
    const gate = { resolve: (_: Response) => {} }
    const fetchFn = vi
      .fn<FetchFn>()
      .mockImplementationOnce(() => new Promise<Response>((r) => (gate.resolve = r)))
      .mockImplementation(async () => okResponse())
    const warmer = new SummaryWarmer(() => prompt(`transcript v${version}`), asDeps(fetchFn))

    warmer.poke() // starts warm with v1 and blocks on the gate
    version = 2
    warmer.poke()
    version = 3
    warmer.poke()
    version = 4
    warmer.poke()
    gate.resolve(okResponse())

    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2))
    await settle()
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(sentBody(fetchFn, 0).messages).toMatchObject([{}, { content: 'transcript v1' }])
    expect(sentBody(fetchFn, 1).messages).toMatchObject([{}, { content: 'transcript v4' }])
  })

  it('disables itself after three consecutive failures', async () => {
    const fetchFn = vi.fn<FetchFn>(async () => {
      throw new Error('connection refused')
    })
    const warmer = new SummaryWarmer(() => prompt('transcript'), asDeps(fetchFn))

    for (let i = 0; i < 3; i++) {
      warmer.poke()
      await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(i + 1))
      await settle()
    }
    warmer.poke()
    await settle()

    expect(fetchFn).toHaveBeenCalledTimes(3)
  })

  it('resets the failure counter on success', async () => {
    const fetchFn = vi
      .fn<FetchFn>()
      .mockRejectedValueOnce(new Error('down'))
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce(okResponse())
      .mockRejectedValueOnce(new Error('down'))
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValue(okResponse())
    const warmer = new SummaryWarmer(() => prompt('transcript'), asDeps(fetchFn))

    for (let i = 0; i < 6; i++) {
      warmer.poke()
      await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(i + 1))
      await settle()
    }

    // Six requests went out: two failure runs were each cut short by a success.
    expect(fetchFn).toHaveBeenCalledTimes(6)
  })

  it('skips the request when buildPrompt returns null, without counting a failure', async () => {
    let ready = false
    const fetchFn = vi.fn<FetchFn>(async () => okResponse())
    const warmer = new SummaryWarmer(() => (ready ? prompt('transcript') : null), asDeps(fetchFn))

    warmer.poke()
    await settle()
    expect(fetchFn).not.toHaveBeenCalled()

    ready = true
    warmer.poke()
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1))
  })

  it('stop() aborts the in-flight request and blocks future pokes', async () => {
    let seenSignal: AbortSignal | undefined
    const fetchFn = vi.fn<FetchFn>(
      (_url, init) =>
        new Promise<Response>((_, reject) => {
          seenSignal = init.signal as AbortSignal
          seenSignal.addEventListener('abort', () => reject(new Error('aborted')))
        })
    )
    const warmer = new SummaryWarmer(() => prompt('transcript'), asDeps(fetchFn))

    warmer.poke()
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1))
    warmer.stop()

    expect(seenSignal?.aborted).toBe(true)
    warmer.poke()
    await settle()
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })
})
