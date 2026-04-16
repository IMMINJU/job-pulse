import { z } from 'zod'
import type { Collector, CollectorContext, RawJob } from './index.ts'
import { matchSegment } from '../segment/match.ts'

const RemotiveJobSchema = z.object({
  id: z.number(),
  title: z.string(),
  company_name: z.string().optional().nullable(),
  candidate_required_location: z.string().optional().nullable(),
  publication_date: z.string().optional().nullable(),
  tags: z.array(z.string()).optional().nullable(),
})

// Intentionally strict (no .passthrough()): Remotive TOS forbids redistributing
// individual job URLs. Dropping unknown fields here keeps url/redirect_url out of raw_json.
const RemotiveResponseSchema = z.object({
  jobs: z.array(RemotiveJobSchema),
})

const ENDPOINT = 'https://remotive.com/api/remote-jobs'

export const remotive: Collector = {
  name: 'remotive',

  async collect(ctx: CollectorContext): Promise<RawJob[]> {
    const res = await fetch(ENDPOINT, {
      headers: {
        accept: 'application/json',
        // Remotive TOS: identify yourself so they can contact before blocking
        'user-agent': 'job-pulse/0.1 (+https://github.com/IMMINJU/job-pulse)',
      },
    })
    if (!res.ok) throw new Error(`remotive ${res.status} ${res.statusText}`)

    const body = RemotiveResponseSchema.parse(await res.json())
    return body.jobs.map((j) => ({
      source: 'remotive',
      externalId: String(j.id),
      postedAt: j.publication_date ? new Date(j.publication_date) : null,
      title: j.title,
      company: j.company_name ?? null,
      location: j.candidate_required_location ?? null,
      remote: true, // Remotive is remote-only by definition
      tags: j.tags ?? null,
      segment: matchSegment({ title: j.title, tags: j.tags }, ctx.segments),
      raw: j,
    }))
  },
}
