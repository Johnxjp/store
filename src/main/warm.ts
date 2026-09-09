// Cache warming: after each live-transcribed chunk, send Ollama the current
// full summary prompt asking for exactly one (discarded) token. llama.cpp's
// prefix cache accumulates the prompt-reading work as the meeting runs, so
// the real summary request at Stop only has to read the last ~30s of
// transcript instead of the whole thing (measured: prefill 38s → ~1-4s).
import { readConfig } from './config'
import type { ChatPrompt } from './enhance'

const KEEP_ALIVE = '15m'
const MAX_CONSECUTIVE_FAILURES = 3

interface WarmerDeps {
  fetchFn?: typeof fetch
}

export class SummaryWarmer {
  private inFlight = false
  private dirty = false
  private failures = 0
  private disabled = false
  private stopped = false
  private abort: AbortController | null = null
  private readonly fetchFn: typeof fetch

  /** buildPrompt returns the current full prompt, or null to skip this warm (e.g. transcript over the truncation cap). */
  constructor(
    private readonly buildPrompt: () => ChatPrompt | null,
    deps: WarmerDeps = {}
  ) {
    this.fetchFn = deps.fetchFn ?? fetch
  }

  /**
   * Requests a warm with the latest state. Never more than one request in
   * flight: pokes during a warm coalesce into exactly one follow-up.
   */
  poke(): void {
    if (this.stopped || this.disabled) return
    if (this.inFlight) {
      this.dirty = true
      return
    }
    void this.run()
  }

  /** Aborts any in-flight warm and blocks future pokes (call before the real summary request). */
  stop(): void {
    this.stopped = true
    this.abort?.abort()
  }

  private async run(): Promise<void> {
    this.inFlight = true
    try {
      do {
        this.dirty = false
        await this.warmOnce()
      } while (this.dirty && !this.stopped && !this.disabled)
    } finally {
      this.inFlight = false
    }
  }

  private async warmOnce(): Promise<void> {
    const prompt = this.buildPrompt()
    if (!prompt) return
    // Fresh config and the same message structure as generateNotes — the
    // final request must hit the exact byte prefix this one prefills.
    const config = readConfig()
    this.abort = new AbortController()
    const started = Date.now()
    try {
      const res = await this.fetchFn(`${config.ollamaUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: this.abort.signal,
        body: JSON.stringify({
          model: config.ollamaModel,
          stream: false,
          keep_alive: KEEP_ALIVE,
          options: { temperature: 0, num_ctx: config.numCtx, num_predict: 1 },
          messages: [
            { role: 'system', content: prompt.system },
            { role: 'user', content: prompt.user }
          ]
        })
      })
      if (!res.ok) throw new Error(`Ollama error ${res.status}`)
      const body = (await res.json()) as { prompt_eval_count?: number }
      this.failures = 0
      console.log(
        `[warm] prefilled ${body.prompt_eval_count ?? '?'} prompt tokens in ` +
          `${((Date.now() - started) / 1000).toFixed(1)}s`
      )
    } catch (err) {
      if (this.stopped) return
      this.failures++
      if (this.failures >= MAX_CONSECUTIVE_FAILURES) {
        this.disabled = true
        console.error(
          `[warm] disabled for this session after ${MAX_CONSECUTIVE_FAILURES} consecutive failures:`,
          err
        )
      } else {
        console.error('[warm] request failed:', err)
      }
    } finally {
      this.abort = null
    }
  }
}
