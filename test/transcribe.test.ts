import { describe, expect, it } from 'vitest'
import {
  boostGainDb,
  isSilent,
  parseMaxVolumeDb,
  parseWhisperJson,
  SILENCE_MAX_DB,
  TARGET_PEAK_DB
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

describe('parseWhisperJson', () => {
  it('maps whisper-cli output to segments', () => {
    const raw = JSON.stringify({
      transcription: [{ offsets: { from: 0, to: 1500 }, text: ' hello' }]
    })
    expect(parseWhisperJson(raw)).toEqual([{ fromMs: 0, toMs: 1500, text: ' hello' }])
  })

  it('handles missing transcription array', () => {
    expect(parseWhisperJson('{}')).toEqual([])
  })
})
