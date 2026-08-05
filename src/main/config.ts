import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from './paths'

export interface Config {
  /** Ollama model used for note generation. Edit data/config.json to change. */
  ollamaModel: string
  /** Base URL of the Ollama server. Edit data/config.json to change. */
  ollamaUrl: string
  /**
   * Context window (tokens) requested from Ollama. Without an explicit num_ctx
   * Ollama defaults to 4096 and silently truncates the transcript (a 1h meeting
   * is ~16k tokens). 32768 is qwen2.5's native max.
   */
  numCtx: number
  /**
   * Transcript cap (chars) for the summary prompt. Coupled to numCtx — scale
   * them together when changing models: maxTranscriptChars ≈ (numCtx - 5000
   * tokens of headroom for the system prompt and generated notes) × 4 chars
   * per token. E.g. 32768 → (32768 - 5000) × 4 ≈ 110000.
   */
  maxTranscriptChars: number
}

// Fallbacks for a missing/corrupt config.json only — the real values live in
// data/config.json (currently qwen2.5:14b).
const DEFAULTS: Config = {
  ollamaModel: 'llama3.2',
  ollamaUrl: 'http://localhost:11434',
  numCtx: 32_768,
  maxTranscriptChars: 110_000
}

const configPath = join(dataDir, 'config.json')

/** Read fresh on every use so config edits apply without an app restart. */
export function readConfig(): Config {
  if (!existsSync(configPath)) {
    writeFileSync(configPath, JSON.stringify(DEFAULTS, null, 2) + '\n')
    return { ...DEFAULTS }
  }
  try {
    return { ...DEFAULTS, ...(JSON.parse(readFileSync(configPath, 'utf-8')) as Partial<Config>) }
  } catch {
    return { ...DEFAULTS }
  }
}
