import { describe, expect, it } from 'vitest'
import {
  boostGainDb,
  isSilent,
  parseFluidJson,
  parseMaxVolumeDb,
  SILENCE_MAX_DB,
  TARGET_PEAK_DB,
  wordsToSegments,
  type FluidWord
} from '../src/main/transcribe'

describe('parseMaxVolumeDb', () => {
  it('parses max_volume from ffmpeg volumedetect stderr', () => {
    const stderr = [
      '[Parsed_volumedetect_0 @ 0x123] n_samples: 22780800',
      '[Parsed_volumedetect_0 @ 0x123] mean_volume: -54.4 dB',
      '[Parsed_volumedetect_0 @ 0x123] max_volume: -28.9 dB'
    ].join('\n')
    expect(parseMaxVolumeDb(stderr)).toBe(-28.9)
  })

  it('returns -Infinity when no report is present', () => {
    expect(parseMaxVolumeDb('ffmpeg version 7.0')).toBe(-Infinity)
  })
})

describe('isSilent', () => {
  it('gates dead streams (~-91 dB) and missing reports', () => {
    expect(isSilent(-91)).toBe(true)
    expect(isSilent(-Infinity)).toBe(true)
  })

  it('passes quiet-but-real speech peaks', () => {
    // Regression: a quiet mic peaking at -28.9 dB was gated by the old
    // mean-volume threshold despite holding a full conversation.
    expect(isSilent(-28.9)).toBe(false)
  })

  it('uses SILENCE_MAX_DB as the boundary', () => {
    expect(isSilent(SILENCE_MAX_DB - 0.1)).toBe(true)
    expect(isSilent(SILENCE_MAX_DB)).toBe(false)
  })
})

describe('boostGainDb', () => {
  it('boosts a quiet stream up to the target peak', () => {
    expect(boostGainDb(-28.9)).toBeCloseTo(TARGET_PEAK_DB - -28.9)
  })

  it('leaves healthy streams alone', () => {
    expect(boostGainDb(-0.8)).toBe(0)
    expect(boostGainDb(TARGET_PEAK_DB)).toBe(0)
  })

  it('skips boosts too small to matter', () => {
    expect(boostGainDb(-5)).toBe(0)
  })
})

describe('parseFluidJson', () => {
  it('reads the fluid-transcribe word array', () => {
    const raw = JSON.stringify({
      words: [{ word: 'Hello.', start: 1.2, end: 1.8 }]
    })
    expect(parseFluidJson(raw)).toEqual([{ word: 'Hello.', start: 1.2, end: 1.8 }])
  })

  it('handles a missing words array', () => {
    expect(parseFluidJson('{}')).toEqual([])
  })
})

const w = (word: string, start: number, end: number): FluidWord => ({ word, start, end })

describe('wordsToSegments', () => {
  it('returns nothing for no words', () => {
    expect(wordsToSegments([])).toEqual([])
  })

  it('groups words up to sentence-ending punctuation', () => {
    const segments = wordsToSegments([
      w('Hi,', 0.5, 0.7),
      w('there.', 0.8, 1.1),
      w('How', 1.3, 1.5),
      w('are', 1.5, 1.6),
      w('you?', 1.6, 1.9)
    ])
    expect(segments).toEqual([
      { fromMs: 500, toMs: 1100, text: 'Hi, there.' },
      { fromMs: 1300, toMs: 1900, text: 'How are you?' }
    ])
  })

  it('treats punctuation followed by a closing quote as a sentence end', () => {
    const segments = wordsToSegments([w('"Done."', 0, 0.4), w('Next', 0.5, 0.8)])
    expect(segments.map((s) => s.text)).toEqual(['"Done."', 'Next'])
  })

  it('splits on a long pause even without punctuation', () => {
    const segments = wordsToSegments([w('so', 0, 0.3), w('anyway', 2.5, 2.9)])
    expect(segments).toEqual([
      { fromMs: 0, toMs: 300, text: 'so' },
      { fromMs: 2500, toMs: 2900, text: 'anyway' }
    ])
  })

  it('keeps a short pause inside one segment', () => {
    const segments = wordsToSegments([w('so', 0, 0.3), w('anyway', 1.0, 1.4)])
    expect(segments).toEqual([{ fromMs: 0, toMs: 1400, text: 'so anyway' }])
  })
})
