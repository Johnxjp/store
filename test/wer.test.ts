import { describe, expect, it } from 'vitest'
import {
  appSegmentsText,
  normalizeWords,
  parseGranola,
  parseOwnApp,
  wordEditDistance,
  wordErrorRate
} from '../experiments/lib/wer'

describe('normalizeWords', () => {
  it('lowercases, strips punctuation, splits', () => {
    expect(normalizeWords("It's a Test, really.")).toEqual(['its', 'a', 'test', 'really'])
  })

  it('handles empty input', () => {
    expect(normalizeWords('  \n ')).toEqual([])
  })
})

describe('wordEditDistance', () => {
  it('is zero for identical sequences', () => {
    expect(wordEditDistance(['a', 'b'], ['a', 'b'])).toBe(0)
  })

  it('counts substitutions, insertions, deletions', () => {
    expect(wordEditDistance(['the', 'cat', 'sat'], ['the', 'dog', 'sat'])).toBe(1)
    expect(wordEditDistance(['a', 'b'], ['a', 'x', 'b'])).toBe(1)
    expect(wordEditDistance(['a', 'x', 'b'], ['a', 'b'])).toBe(1)
  })

  it('handles empty sequences', () => {
    expect(wordEditDistance([], ['a', 'b'])).toBe(2)
    expect(wordEditDistance(['a', 'b'], [])).toBe(2)
  })
})

describe('wordErrorRate', () => {
  it('computes WER against the reference length', () => {
    const r = wordErrorRate('the cat sat on the mat', 'the cat sat on a mat')
    expect(r.refWords).toBe(6)
    expect(r.editDistance).toBe(1)
    expect(r.wer).toBeCloseTo(1 / 6)
  })
})

describe('parseGranola', () => {
  it('returns text after the Transcript: marker', () => {
    const md = 'Meeting Title: X\nDate: Y\n\nTranscript:\nHello there. General Kenobi.'
    expect(parseGranola(md)).toBe('Hello there. General Kenobi.')
  })

  it('throws without a marker', () => {
    expect(() => parseGranola('no marker here')).toThrow()
  })
})

describe('parseOwnApp', () => {
  it('parses timestamp/speaker/text blocks', () => {
    const md = '02:29\nMe\nHello.\n02:30\nThem\nHi back.\nSecond line.\n82:51\nMe\nBye.'
    const segments = parseOwnApp(md)
    expect(segments).toEqual([
      { timestamp: '02:29', speaker: 'Me', text: 'Hello.' },
      { timestamp: '02:30', speaker: 'Them', text: 'Hi back. Second line.' },
      { timestamp: '82:51', speaker: 'Me', text: 'Bye.' }
    ])
    expect(appSegmentsText(segments)).toBe('Hello. Hi back. Second line. Bye.')
  })
})
