import { z } from 'zod'
import type { Collector, CollectorContext, RawJob } from './index.ts'
import { matchSegment } from '../segment/match.ts'

const ArbeitnowJobSchema = z.object({
  slug: z.string(),
  title: z.string(),
  company_name: z.string().optional().nullable(),
  location: z.string().optional().nullable(),
  remote: z.boolean().optional().nullable(),
  tags: z.array(z.string()).optional().nullable(),
  created_at: z.number(), // unix epoch seconds
})

const ArbeitnowResponseSchema = z.object({
  data: z.array(ArbeitnowJobSchema.passthrough()),
  links: z
    .object({
      next: z.string().nullable().optional(),
    })
    .passthrough()
    .optional(),
})

const ENDPOINT = 'https://www.arbeitnow.com/api/job-board-api'
const MAX_PAGES = 5 // ~500 jobs; Arbeitnow orders by created_at desc so recent first

export const arbeitnow: Collector = {
  name: 'arbeitnow',

  async collect(ctx: CollectorContext): Promise<RawJob[]> {
    const cutoffSec = Math.floor(ctx.now.getTime() / 1000) - 7 * 24 * 3600
    const out: RawJob[] = []
    let url: string | null = ENDPOINT
    let page = 0

    while (url && page < MAX_PAGES) {
      const res: Response = await fetch(url, {
        headers: {
          accept: 'application/json',
          'user-agent': 'job-pulse/0.1 (+https://github.com/IMMINJU/job-pulse)',
        },
      })
      if (!res.ok) throw new Error(`arbeitnow ${res.status} ${res.statusText}`)
      const body = ArbeitnowResponseSchema.parse(await res.json())

      let reachedCutoff = false
      for (const j of body.data) {
        if (j.created_at < cutoffSec) {
          reachedCutoff = true
          continue
        }
        out.push({
          source: 'arbeitnow',
          externalId: j.slug,
          postedAt: new Date(j.created_at * 1000),
          title: j.title,
          company: j.company_name ?? null,
          location: j.location ?? null,
          remote: j.remote ?? null,
          tags: j.tags ?? null,
          segment: matchSegment({ title: j.title, tags: j.tags }, ctx.segments),
          raw: j,
        })
      }

      if (reachedCutoff) break
      url = body.links?.next ?? null
      page += 1
    }

    return out
  },
}
