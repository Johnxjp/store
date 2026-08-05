// Compares parakeet-tdt-0.6b-v3 output for the system ("Them") stream of the
// reference meeting against the Granola reference, alongside whisper's output for
// the same stream. Run experiments/parakeet/run_parakeet.py first.
// Usage: npx tsx experiments/compare-parakeet.ts
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { appSegmentsText, parseGranola, parseOwnApp, wordErrorRate } from './lib/wer'

const exampleDir = 'data/examples/reference-meeting'
const granolaText = parseGranola(readFileSync(join(exampleDir, 'granola_transcript.md'), 'utf-8'))
const appSegments = parseOwnApp(readFileSync(join(exampleDir, 'own_app_transcript.md'), 'utf-8'))
const whisperThemText = appSegmentsText(appSegments.filter((s) => s.speaker === 'Them'))
const parakeetThemText = readFileSync('experiments/parakeet/parakeet-them.txt', 'utf-8')
const parakeetMlxThemText = readFileSync('experiments/parakeet/parakeet-mlx-them.txt', 'utf-8')

const results = {
  granolaVsWhisperThem: wordErrorRate(granolaText, whisperThemText),
  granolaVsParakeetThem: wordErrorRate(granolaText, parakeetThemText),
  granolaVsParakeetMlxThem: wordErrorRate(granolaText, parakeetMlxThemText),
  whisperThemVsParakeetThem: wordErrorRate(whisperThemText, parakeetThemText),
  parakeetHfVsMlx: wordErrorRate(parakeetThemText, parakeetMlxThemText)
}

const outDir = 'experiments/results'
mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, 'parakeet-vs-whisper.json'), JSON.stringify(results, null, 2))
console.log(JSON.stringify(results, null, 2))
