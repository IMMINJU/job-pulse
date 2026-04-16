import type { ReportMessage, ReportSection } from '../notifier/index.ts'
import type { BucketStat, SegmentStat, WeeklyAggregate } from './aggregate.ts'

const SPARK = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']

function sparkline(values: number[]): string {
  if (values.length === 0) return ''
  const max = Math.max(...values, 1)
  return values
    .map((v) => SPARK[Math.min(SPARK.length - 1, Math.floor((v / max) * (SPARK.length - 1)))])
    .join('')
}

function arrow(changePct: number | null): string {
  if (changePct === null) return '—'
  if (Math.abs(changePct) < 1) return '→'
  return changePct > 0 ? `↑ ${Math.round(changePct)}%` : `↓ ${Math.round(Math.abs(changePct))}%`
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length)
}

function padLeft(s: string, n: number): string {
  return s.length >= n ? s : ' '.repeat(n - s.length) + s
}

function formatDateRange(start: string, end: string): string {
  const s = new Date(start)
  const e = new Date(end)
  return `${s.getUTCMonth() + 1}/${s.getUTCDate()} – ${e.getUTCMonth() + 1}/${e.getUTCDate()}`
}

function formatSegmentLine(s: SegmentStat): string {
  return `${pad(s.segment, 10)}${padLeft(String(s.total), 6)}   ${pad(arrow(s.changePct), 8)} ${sparkline(s.daily)}`
}

function formatBucketSection(bucket: BucketStat): ReportSection[] {
  const segBody = bucket.segments.map(formatSegmentLine).join('\n')
  const moverBody = bucket.topMovers.length
    ? bucket.topMovers.map((m) => `  · ${m.segment} ${arrow(m.changePct)}  (prev ${m.prevTotal})`).join('\n')
    : '  (no significant movers)'
  return [
    { heading: bucket.label, body: segBody, mono: true },
    { heading: `${bucket.label} · top movers`, body: moverBody, mono: true },
  ]
}

function totalPostings(agg: WeeklyAggregate): number {
  return agg.buckets.reduce(
    (sum, b) => sum + b.segments.reduce((a, s) => a + s.total, 0),
    0,
  )
}

export function buildReportMessage(agg: WeeklyAggregate, insightText: string): ReportMessage {
  const range = formatDateRange(agg.weekStart, agg.weekEnd)
  const title = `Developer Hiring Weekly (${range})`

  const bucketSections = agg.buckets.flatMap(formatBucketSection)

  const tagLines = agg.newTags.length
    ? agg.newTags.slice(0, 5).map((t) => `  · "${t.tag}" (x${t.total_count})`)
    : ['  (no new tags)']

  return {
    title,
    summary: `Weekly hiring summary, UTC Mon-Sun. ${totalPostings(agg)} postings tracked across ${agg.buckets.length} source groups.`,
    sections: [
      ...bucketSections,
      { heading: 'New tags', body: tagLines.join('\n') },
      { heading: 'Insight', body: insightText },
    ],
    footer: 'Sources: Remotive, Arbeitnow, Adzuna, JSearch, Hacker News "Who is Hiring"',
  }
}
