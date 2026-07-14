import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from './paths'

export interface Config {
  /** Ollama model used for note generation. Edit data/config.json to change. */
  ollamaModel: string
}

// llama3.2 is the only model currently loadable on this machine; switch to
// qwen3.6:35b (or a re-pulled gpt-oss:20b) in data/config.json once downloaded.
const DEFAULTS: Config = { ollamaModel: 'llama3.2' }

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
