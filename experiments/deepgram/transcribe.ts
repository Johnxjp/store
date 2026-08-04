// Sends local recording WAVs to Deepgram (nova-3) and saves the responses.
// NOTE: this experiment deliberately violates the app's local-only rule —
// audio is uploaded to Deepgram's cloud. Benchmark use only.
//
// API key: put it in experiments/deepgram/.env as DEEPGRAM_API_KEY=<key>
// (gitignored), or export DEEPGRAM_API_KEY in the shell.
// Usage: npx tsx experiments/deepgram/transcribe.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// The 5 most recent meetings, both streams each.
const FILES = [
  'a4161983-7bb8-4005-920d-5bc5a5e3cb2f/system-16k.wav', // Jul 28, 21 s
  'a4161983-7bb8-4005-920d-5bc5a5e3cb2f/mic-16k.wav',
  '5c337054-efd7-4ee1-9426-f2400d0502c3/system-16k.wav', // Jul 28, 67 s
  '5c337054-efd7-4ee1-9426-f2400d0502c3/mic-16k.wav',
  'a24602ac-a148-47cb-b2db-ae7793250dce/system.wav', // Jul 28, 22 s (raw 48k only)
  'a24602ac-a148-47cb-b2db-ae7793250dce/mic.wav',
  'ba784f46-7a20-470c-9af5-5a3d96d9cd8c/system-16k.wav', // Jul 27, 83 min, the WER benchmark meeting
  'ba784f46-7a20-470c-9af5-5a3d96d9cd8c/mic-16k.wav',
  '406c80a0-eb15-42e1-84fa-52dde8e15dc9/system-16k.wav', // Jul 27, 35 min
  '406c80a0-eb15-42e1-84fa-52dde8e15dc9/mic-16k.wav'
]

const dgDir = 'experiments/deepgram'

function apiKey(): string {
  if (process.env.DEEPGRAM_API_KEY) return process.env.DEEPGRAM_API_KEY
  const envFile = join(dgDir, '.env')
  if (existsSync(envFile)) {
    const match = readFileSync(envFile, 'utf-8').match(/^DEEPGRAM_API_KEY=(.+)$/m)
    if (match) return match[1].trim()
  }
  throw new Error(`no API key: set DEEPGRAM_API_KEY or put it in ${envFile}`)
}

const key = apiKey()
const outDir = join(dgDir, 'results')
mkdirSync(outDir, { recursive: true })

const params = new URLSearchParams({
  model: 'nova-3',
  language: 'en',
  smart_format: 'true'
})

for (const rel of FILES) {
  const name = rel.replace('/', '_').replace('.wav', '')
  const audio = readFileSync(join('data/recordings', rel))
  process.stdout.write(`${rel} (${(audio.length / 1e6).toFixed(0)} MB)... `)
  const t0 = Date.now()
  const res = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
    method: 'POST',
    headers: { Authorization: `Token ${key}`, 'Content-Type': 'audio/wav' },
    body: audio
  })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`)
  const json = (await res.json()) as {
    results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string }> }> }
  }
  const seconds = ((Date.now() - t0) / 1000).toFixed(1)
  const alt = json.results?.channels?.[0]?.alternatives?.[0]
  const text: string = alt?.transcript ?? ''
  writeFileSync(join(outDir, `${name}.json`), JSON.stringify(json, null, 2))
  writeFileSync(join(outDir, `${name}.txt`), text + '\n')
  console.log(`${seconds}s, ${text.split(/\s+/).filter(Boolean).length} words`)
}
console.log(`saved to ${outDir}`)
