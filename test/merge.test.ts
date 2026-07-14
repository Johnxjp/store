import { describe, expect, it } from 'vitest'
import {
  dropHallucinations,
  formatTimestamp,
  formatTranscript,
  mergeTranscripts,
  type WhisperSegment
} from '../src/main/merge'

const seg = (fromMs: number, toMs: number, text: string): WhisperSegment => ({ fromMs, toMs, text })

describe('mergeTranscripts', () => {
  it('interleaves mic and system segments chronologically', () => {
    const result = mergeTranscripts(
      { segments: [seg(0, 2000, 'hello'), seg(10_000, 12_000, 'sounds good')], epochMs: 1000 },
      { segments: [seg(4000, 6000, 'hi there')], epochMs: 1000 }
    )
    expect(result.map((s) => [s.speaker, s.text])).toEqual([
      ['me', 'hello'],
      ['them', 'hi there'],
      ['me', 'sounds good']
    ])
  })

  it('aligns streams that started at different wall-clock times', () => {
    // System stream started 3s after mic: its segments shift +3000ms.
    const result = mergeTranscripts(
      { segments: [seg(0, 1000, 'first')], epochMs: 10_000 },
      { segments: [seg(0, 1000, 'second')], epochMs: 13_000 }
    )
    expect(result[0]).toMatchObject({ speaker: 'me', startMs: 0 })
    expect(result[1]).toMatchObject({ speaker: 'them', startMs: 3000, endMs: 4000 })
  })

  it('coalesces consecutive same-speaker segments with small gaps', () => {
    const result = mergeTranscripts(
      {
        segments: [seg(0, 2000, 'one'), seg(2500, 4000, 'two'), seg(9000, 10_000, 'far away')],
        epochMs: 0
      },
      { segments: [], epochMs: 0 }
    )
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ text: 'one two', startMs: 0, endMs: 4000 })
    expect(result[1]).toMatchObject({ text: 'far away' })
  })

  it('does not coalesce across a speaker change', () => {
    const result = mergeTranscripts(
      { segments: [seg(0, 1000, 'a'), seg(3000, 4000, 'b')], epochMs: 0 },
      { segments: [seg(1500, 2500, 'x')], epochMs: 0 }
    )
    expect(result.map((s) => s.text)).toEqual(['a', 'x', 'b'])
  })

  it('handles an empty stream', () => {
    const result = mergeTranscripts(
      { segments: [], epochMs: 0 },
      { segments: [seg(0, 1000, 'only them')], epochMs: 0 }
    )
    expect(result).toEqual([{ speaker: 'them', startMs: 0, endMs: 1000, text: 'only them' }])
  })
})

describe('dropHallucinations', () => {
  it('drops empty and bracketed filler segments', () => {
    const result = dropHallucinations([
      seg(0, 1, '  '),
      seg(1, 2, '[BLANK_AUDIO]'),
      seg(2, 3, '(soft music)'),
      seg(3, 4, '♪ ♪'),
      seg(4, 5, 'real speech')
    ])
    expect(result.map((s) => s.text)).toEqual(['real speech'])
  })

  it('drops runs of 3+ identical segments', () => {
    const result = dropHallucinations([
      seg(0, 1, 'Thanks for watching.'),
      seg(1, 2, 'Thanks for watching.'),
      seg(2, 3, 'thanks for watching.'),
      seg(3, 4, 'actual content')
    ])
    expect(result.map((s) => s.text)).toEqual(['actual content'])
  })

  it('keeps a phrase repeated only twice', () => {
    const result = dropHallucinations([seg(0, 1, 'yes'), seg(1, 2, 'yes'), seg(2, 3, 'no')])
    expect(result.map((s) => s.text)).toEqual(['yes', 'yes', 'no'])
  })

  it('keeps brackets embedded within real speech', () => {
    const result = dropHallucinations([seg(0, 1, 'the [important] part')])
    expect(result).toHaveLength(1)
  })

  it('drops known silence phrases like "Thank you."', () => {
    const result = dropHallucinations([
      seg(0, 1, ' Thank you.'),
      seg(1, 2, 'Thanks for watching!'),
      seg(2, 3, 'you'),
      seg(3, 4, 'Bye.'),
      seg(4, 5, 'thank you for the update on pricing')
    ])
    expect(result.map((s) => s.text)).toEqual(['thank you for the update on pricing'])
  })
})

describe('formatting', () => {
  it('formats timestamps as mm:ss', () => {
    expect(formatTimestamp(0)).toBe('00:00')
    expect(formatTimestamp(65_000)).toBe('01:05')
    expect(formatTimestamp(600_000)).toBe('10:00')
  })

  it('formats a transcript with speaker labels', () => {
    const text = formatTranscript([
      { speaker: 'me', startMs: 0, endMs: 1000, text: 'hello' },
      { speaker: 'them', startMs: 61_000, endMs: 62_000, text: 'hi' }
    ])
    expect(text).toBe('[00:00] Me: hello\n[01:01] Them: hi')
  })
})
