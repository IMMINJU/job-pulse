import { z } from 'zod'
import OpenAI from 'openai'
import type { Collector, CollectorContext, RawJob } from './index.ts'
import { matchSegment } from '../segment/match.ts'

const WHOISHIRING_USER = 'https://hacker-news.firebaseio.com/v0/user/whoishiring.json'
const ITEM_URL = (id: number) => `https://hacker-news.firebaseio.com/v0/item/${id}.json`

const UserSchema = z.object({ submitted: z.array(z.number()) })
const ThreadSchema = z.object({
  id: z.number(),
  title: z.string().optional(),
  time: z.number(),
  kids: z.array(z.number()).optional(),
})
const CommentSchema = z.object({
  id: z.number(),
  text: z.string().optional(),
  deleted: z.boolean().optional(),
  dead: z.boolean().optional(),
})

const ExtractedJobSchema = z.object({
  comment_id: z.number(),
  company: z.string().nullable(),
  role: z.string(),
  location: z.union([z.string(), z.array(z.string())]).nullable().transform(
    (v) => (Array.isArray(v) ? v.join(', ') : v),
  ),
  remote: z.boolean().nullable(),
  stack: z.array(z.string()),
})
const ExtractedBatchSchema = z.object({ jobs: z.array(ExtractedJobSchema) })

const BATCH_SIZE = 40
const MODEL = process.env.OPENAI_MODEL ?? 'gpt-4.1-mini'

async function fetchJson<T>(url: string, schema: z.ZodType<T>): Promise<T> {
  const res = await fetch(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'job-pulse/0.1 (+https://github.com/IMMINJU/job-pulse)',
    },
  })
  if (!res.ok) throw new Error(`hn ${res.status} ${res.statusText} (${url})`)
  return schema.parse(await res.json())
}

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x2F;/g, '/')
    .replace(/\s+/g, ' ')
    .trim()
}

async function findLatestThread(now: Date): Promise<z.infer<typeof ThreadSchema>> {
  const user = await fetchJson(WHOISHIRING_USER, UserSchema)
  // whoishiring submits 3 posts per month (Who is hiring / Freelancer / Who wants); we want the 'hiring' one.
  // Walk most-recent first, open items until title starts with 'Ask HN: Who is hiring?'.
  for (const id of user.submitted.slice(0, 12)) {
    const item = await fetchJson(ITEM_URL(id), ThreadSchema)
    if (item.title?.toLowerCase().startsWith('ask hn: who is hiring?')) {
      // sanity: must be current or previous month
      const age = now.getTime() - item.time * 1000
      if (age < 45 * 24 * 3600 * 1000) return item
    }
  }
  throw new Error('hn: no recent "Who is hiring" thread found')
}

async function fetchComments(ids: number[]): Promise<Array<{ id: number; text: string }>> {
  const out: Array<{ id: number; text: string }> = []
  const batch = 20
  for (let i = 0; i < ids.length; i += batch) {
    const slice = ids.slice(i, i + batch)
    const results = await Promise.all(slice.map((id) => fetchJson(ITEM_URL(id), CommentSchema)))
    for (const c of results) {
      if (c.deleted || c.dead || !c.text) continue
      out.push({ id: c.id, text: stripHtml(c.text) })
    }
  }
  return out
}

async function extractBatch(
  client: OpenAI,
  batch: Array<{ id: number; text: string }>,
): Promise<Array<z.infer<typeof ExtractedJobSchema>>> {
  const system =
    'Extract hiring posts from Hacker News "Who is hiring?" comments. ' +
    'Each top-level comment is one posting. Return ONLY valid JSON matching the schema. ' +
    'If a comment is not a job posting, omit it from the output.'

  const user = [
    'Schema: { "jobs": [{ "comment_id": number, "company": string|null, "role": string, "location": string|null, "remote": boolean|null, "stack": string[] }] }',
    '',
    'Comments:',
    ...batch.map((c) => `--- id=${c.id} ---\n${c.text}`),
  ].join('\n')

  const res = await client.chat.completions.create({
    model: MODEL,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  })
  const content = res.choices[0]?.message?.content ?? '{"jobs":[]}'
  return ExtractedBatchSchema.parse(JSON.parse(content)).jobs
}

export const hn: Collector = {
  name: 'hn',

  async collect(ctx: CollectorContext): Promise<RawJob[]> {
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) throw new Error('OPENAI_API_KEY is not set')
    const client = new OpenAI({ apiKey })

    const thread = await findLatestThread(ctx.now)
    const kidIds = thread.kids ?? []
    if (kidIds.length === 0) return []

    const comments = await fetchComments(kidIds)

    const out: RawJob[] = []
    const postedAt = new Date(thread.time * 1000)

    for (let i = 0; i < comments.length; i += BATCH_SIZE) {
      const batch = comments.slice(i, i + BATCH_SIZE)
      try {
        const jobs = await extractBatch(client, batch)
        for (const j of jobs) {
          const src = batch.find((c) => c.id === j.comment_id)
          if (!src) continue
          out.push({
            source: 'hn',
            externalId: String(j.comment_id),
            postedAt,
            title: j.role,
            company: j.company,
            location: j.location,
            remote: j.remote,
            tags: j.stack.length > 0 ? j.stack : null,
            segment: matchSegment({ title: j.role, tags: j.stack }, ctx.segments),
            raw: { thread_id: thread.id, comment_id: j.comment_id, text: src.text, extracted: j },
          })
        }
      } catch (err) {
        console.warn(`[hn] batch ${i / BATCH_SIZE + 1} failed (${batch.length} comments dropped):`, err instanceof Error ? err.message : err)
      }
    }

    return out
  },
}
