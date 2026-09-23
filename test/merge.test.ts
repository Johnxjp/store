import { describe, expect, it } from 'vitest'
import {
  dropHallucinations,
  formatTimestamp,
  formatTranscript,
  mergeTranscripts,
  type StreamSegment
} from '../src/main/merge'

const seg = (fromMs: number, toMs: number, text: string): StreamSegment => ({ fromMs, toMs, text })

describe('mergeTranscripts', () => {
  it('interleaves mic and system segments chronologically', () => {
    const result = mergeTranscripts(
      { segments: [seg(0, 2000, 'hello'), seg(10_000, 12_000, 'sounds good')], epochMs: 1000 },
      { segments: [seg(4000, 6000, 'hi there')], epochMs: 1000 },
      []
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
      { segments: [seg(0, 1000, 'second')], epochMs: 13_000 },
      []
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
      { segments: [], epochMs: 0 },
      []
    )
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ text: 'one two', startMs: 0, endMs: 4000 })
    expect(result[1]).toMatchObject({ text: 'far away' })
  })

  it('does not coalesce across a speaker change', () => {
    const result = mergeTranscripts(
      { segments: [seg(0, 1000, 'a'), seg(3000, 4000, 'b')], epochMs: 0 },
      { segments: [seg(1500, 2500, 'x')], epochMs: 0 },
      []
    )
    expect(result.map((s) => s.text)).toEqual(['a', 'x', 'b'])
  })

  it('handles an empty stream', () => {
    const result = mergeTranscripts(
      { segments: [], epochMs: 0 },
      { segments: [seg(0, 1000, 'only them')], epochMs: 0 },
      []
    )
    expect(result).toEqual([{ speaker: 'them', startMs: 0, endMs: 1000, text: 'only them' }])
  })
})

describe('mergeTranscripts with pauses', () => {
  const pause = (fromEpochMs: number, toEpochMs: number) => ({ fromEpochMs, toEpochMs })

  it('subtracts a pause from everything recorded after it', () => {
    const result = mergeTranscripts(
      { segments: [seg(0, 1000, 'before'), seg(20_000, 21_000, 'after')], epochMs: 0 },
      { segments: [], epochMs: 0 },
      [pause(5000, 15_000)]
    )
    expect(result[0]).toMatchObject({ startMs: 0, endMs: 1000 })
    expect(result[1]).toMatchObject({ startMs: 10_000, endMs: 11_000 })
  })

  it('shifts both streams identically, so a pause cannot pull them out of step', () => {
    // Same wall-clock instant, reached from different stream epochs.
    const result = mergeTranscripts(
      { segments: [seg(20_000, 21_000, 'me')], epochMs: 0 },
      { segments: [seg(17_000, 18_000, 'them')], epochMs: 3000 },
      [pause(5000, 15_000)]
    )
    expect(result.map((s) => s.startMs)).toEqual([10_000, 10_000])
  })

  it('does not coalesce same-speaker segments across a pause boundary', () => {
    // Collapsing leaves a 500ms gap, well inside the 2s coalesce window.
    const result = mergeTranscripts(
      { segments: [seg(0, 1000, 'one'), seg(60_500, 61_500, 'two')], epochMs: 0 },
      { segments: [], epochMs: 0 },
      [pause(1000, 60_000)]
    )
    expect(result.map((s) => s.text)).toEqual(['one', 'two'])
  })

  it('clamps a timestamp that lands inside a pause to the pause start', () => {
    const result = mergeTranscripts(
      { segments: [seg(8000, 9000, 'straggler')], epochMs: 0 },
      { segments: [], epochMs: 0 },
      [pause(5000, 15_000)]
    )
    expect(result[0]).toMatchObject({ startMs: 5000, endMs: 5000 })
  })

  it('shortens a segment that spans a pause to its recorded duration', () => {
    const result = mergeTranscripts(
      { segments: [seg(4000, 16_000, 'across')], epochMs: 0 },
      { segments: [], epochMs: 0 },
      [pause(5000, 15_000)]
    )
    expect(result[0]).toMatchObject({ startMs: 4000, endMs: 6000 })
  })

  it('accumulates several pauses', () => {
    const result = mergeTranscripts(
      { segments: [seg(10_000, 11_000, 'last')], epochMs: 0 },
      { segments: [], epochMs: 0 },
      [pause(1000, 2000), pause(5000, 7000)]
    )
    expect(result[0]).toMatchObject({ startMs: 7000, endMs: 8000 })
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
