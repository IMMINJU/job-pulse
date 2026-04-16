import type { Segment } from '../config.ts'
import { UNASSIGNED_SEGMENT } from '../db/types.ts'

// Cache compiled regexes per Segment[] instance
const cache = new WeakMap<Segment[], Array<{ key: string; patterns: RegExp[] }>>()

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function buildPatterns(segments: Segment[]) {
  const cached = cache.get(segments)
  if (cached) return cached
  const compiled = segments.map((seg) => ({
    key: seg.key,
    patterns: seg.keywords.map((kw) => {
      // Word-boundary match. Allow hyphens inside keyword (\b won't split on '-', so 'front-end'
      // needs its own escaped literal with boundaries). We use lookarounds to treat any non-word
      // char (or start/end) as a boundary, so 'ai' matches 'ai engineer' but not 'chains'.
      const escaped = escapeRegex(kw.toLowerCase())
      return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, 'i')
    }),
  }))
  cache.set(segments, compiled)
  return compiled
}

export function matchSegment(
  input: { title: string; tags?: string[] | null },
  segments: Segment[],
): string {
  const haystack = [input.title, ...(input.tags ?? [])].join(' \u0001 ').toLowerCase()
  const compiled = buildPatterns(segments)

  let bestKey = UNASSIGNED_SEGMENT
  let bestScore = 0
  for (const { key, patterns } of compiled) {
    let score = 0
    for (const p of patterns) if (p.test(haystack)) score += 1
    if (score > bestScore) {
      bestScore = score
      bestKey = key
    }
  }
  return bestKey
}
