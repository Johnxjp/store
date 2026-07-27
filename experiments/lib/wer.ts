// Word-error-rate utilities shared by the transcript-comparison experiments.

/** Lowercase, strip punctuation, split into words. "It's" -> "its". */
export function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(Boolean)
}

/** Word-level Levenshtein distance (substitution/insertion/deletion all cost 1). */
export function wordEditDistance(ref: string[], hyp: string[]): number {
  let prev = new Uint32Array(hyp.length + 1)
  let curr = new Uint32Array(hyp.length + 1)
  for (let j = 0; j <= hyp.length; j++) prev[j] = j
  for (let i = 1; i <= ref.length; i++) {
    curr[0] = i
    const refWord = ref[i - 1]
    for (let j = 1; j <= hyp.length; j++) {
      const sub = prev[j - 1] + (refWord === hyp[j - 1] ? 0 : 1)
      const del = prev[j] + 1
      const ins = curr[j - 1] + 1
      curr[j] = Math.min(sub, del, ins)
    }
    ;[prev, curr] = [curr, prev]
  }
  return prev[hyp.length]
}

export interface WerResult {
  refWords: number
  hypWords: number
  editDistance: number
  wer: number
}

export function wordErrorRate(refText: string, hypText: string): WerResult {
  const ref = normalizeWords(refText)
  const hyp = normalizeWords(hypText)
  const editDistance = wordEditDistance(ref, hyp)
  return {
    refWords: ref.length,
    hypWords: hyp.length,
    editDistance,
    wer: editDistance / ref.length
  }
}

/** Granola export: header lines, then everything after the "Transcript:" line. */
export function parseGranola(md: string): string {
  const marker = md.indexOf('Transcript:')
  if (marker === -1) throw new Error('no "Transcript:" marker in Granola file')
  return md.slice(marker + 'Transcript:'.length).trim()
}

export interface AppSegment {
  timestamp: string
  speaker: 'Me' | 'Them'
  text: string
}

/** Our app's export: repeating blocks of "MM:SS\n(Me|Them)\n<text>". */
export function parseOwnApp(md: string): AppSegment[] {
  const lines = md.split('\n')
  const segments: AppSegment[] = []
  let current: AppSegment | null = null
  let pendingTimestamp: string | null = null
  for (const line of lines) {
    if (/^\d+:\d{2}$/.test(line)) {
      pendingTimestamp = line
    } else if ((line === 'Me' || line === 'Them') && pendingTimestamp !== null) {
      if (current) segments.push(current)
      current = { timestamp: pendingTimestamp, speaker: line, text: '' }
      pendingTimestamp = null
    } else if (current) {
      current.text = current.text ? `${current.text} ${line}` : line
    }
  }
  if (current) segments.push(current)
  return segments
}

export function appSegmentsText(segments: AppSegment[]): string {
  return segments.map((s) => s.text).join(' ')
}
