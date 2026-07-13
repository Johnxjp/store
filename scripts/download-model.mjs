import { createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const MODEL = 'ggml-large-v3-turbo.bin'
const URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL}`
const dest = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'models', MODEL)

if (existsSync(dest) && statSync(dest).size > 1_000_000_000) {
  console.log(`Model already present: ${dest}`)
  process.exit(0)
}

mkdirSync(dirname(dest), { recursive: true })
console.log(`Downloading ${URL} (~1.6 GB)...`)
const res = await fetch(URL)
if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`)
await pipeline(Readable.fromWeb(res.body), createWriteStream(dest))
console.log(`Saved to ${dest}`)
