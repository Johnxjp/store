// Compares our app's transcript with Granola's for the same meeting.
// Granola has no speaker labels, so our transcript is flattened to plain text.
// Usage: npx tsx experiments/compare-granola.ts
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { appSegmentsText, parseGranola, parseOwnApp, wordErrorRate } from './lib/wer'

const exampleDir = 'data/examples/reference-meeting'
const granolaText = parseGranola(readFileSync(join(exampleDir, 'granola_transcript.md'), 'utf-8'))
const appSegments = parseOwnApp(readFileSync(join(exampleDir, 'own_app_transcript.md'), 'utf-8'))
const appText = appSegmentsText(appSegments)
const meText = appSegmentsText(appSegments.filter((s) => s.speaker === 'Me'))
const themText = appSegmentsText(appSegments.filter((s) => s.speaker === 'Them'))

const results = {
  granolaAsReference: wordErrorRate(granolaText, appText),
  appAsReference: wordErrorRate(appText, granolaText),
  perStreamVsGranola: {
    meOnly: wordErrorRate(granolaText, meText),
    themOnly: wordErrorRate(granolaText, themText)
  },
  segmentCounts: {
    total: appSegments.length,
    me: appSegments.filter((s) => s.speaker === 'Me').length,
    them: appSegments.filter((s) => s.speaker === 'Them').length
  }
}

const outDir = 'experiments/results'
mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, 'granola-vs-app.json'), JSON.stringify(results, null, 2))
console.log(JSON.stringify(results, null, 2))
