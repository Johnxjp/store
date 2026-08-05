import { describe, expect, it } from 'vitest'
import { buildSummaryPrompt, truncateMiddle } from '../src/main/enhance'
import type { TranscriptSegment } from '../src/shared/types'

const transcript: TranscriptSegment[] = [
  { speaker: 'me', startMs: 0, endMs: 2000, text: 'What is the launch date?' },
  { speaker: 'them', startMs: 3000, endMs: 6000, text: 'October 14th, pending QA.' }
]

describe('buildSummaryPrompt', () => {
  it('includes metadata and the labeled transcript', () => {
    const p = buildSummaryPrompt({ title: 'Launch sync', dateLabel: '13/07/2026', transcript })
    expect(p.user).toContain('Meeting: Launch sync')
    expect(p.user).toContain('Date: 13/07/2026')
    expect(p.user).toContain('[00:00] Me: What is the launch date?')
    expect(p.user).toContain('[00:03] Them: October 14th, pending QA.')
  })

  it('instructs the summary content and guardrails', () => {
    const p = buildSummaryPrompt({ title: 't', dateLabel: 'd', transcript })
    const system = p.system.replace(/\s+/g, ' ')
    expect(system).toContain('core purpose of the meeting')
    expect(system).toContain('"Overview" section')
    expect(system).toContain('topics actually discussed')
    expect(system).toContain('never guess')
    expect(system).toContain('"Next steps" section')
    expect(system).toContain('if no one committed to anything, leave the section out')
    expect(system).toContain('The owner is the speaker of the sentence that made the commitment')
    expect(system).toContain('no outside knowledge')
    expect(system).toContain('no preamble')
  })
})

describe('truncateMiddle', () => {
  it('returns short text unchanged', () => {
    expect(truncateMiddle('hello', 100)).toBe('hello')
  })

  it('cuts the middle of oversized text, keeping both ends', () => {
    const text = 'A'.repeat(600) + 'B'.repeat(600)
    const out = truncateMiddle(text, 200)
    expect(out.length).toBeLessThan(300)
    expect(out.startsWith('AAA')).toBe(true)
    expect(out.endsWith('BBB')).toBe(true)
    expect(out).toContain('[... transcript truncated ...]')
  })
})
