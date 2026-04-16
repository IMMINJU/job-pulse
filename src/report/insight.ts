import OpenAI from 'openai'
import { z } from 'zod'
import type { WeeklyAggregate } from './aggregate.ts'

const MODEL = process.env.OPENAI_MODEL ?? 'gpt-4.1-mini'

const InsightResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string() }),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number(),
      completion_tokens: z.number(),
    })
    .optional(),
})

export interface InsightResult {
  text: string
  costUsd: number | null
}

// gpt-4.1-mini prices (USD per 1M tokens) — kept in code for rough cost tracking.
// Override via env if needed.
const INPUT_USD_PER_MTOK = Number(process.env.OPENAI_INPUT_USD_PER_MTOK ?? '0.20')
const OUTPUT_USD_PER_MTOK = Number(process.env.OPENAI_OUTPUT_USD_PER_MTOK ?? '0.80')

function estimateCost(inputTokens: number, outputTokens: number): number {
  return (inputTokens * INPUT_USD_PER_MTOK + outputTokens * OUTPUT_USD_PER_MTOK) / 1_000_000
}

function compactAggregate(agg: WeeklyAggregate) {
  return {
    week: `${agg.weekStart}..${agg.weekEnd}`,
    prev_week: `${agg.prevWeekStart}..${agg.prevWeekEnd}`,
    buckets: agg.buckets.map((b) => ({
      key: b.key,
      label: b.label,
      segments: b.segments.map((s) => ({
        key: s.segment,
        total: s.total,
        prev_total: s.prevTotal,
        change_pct: s.changePct === null ? null : Number(s.changePct.toFixed(1)),
      })),
      top_movers: b.topMovers.map((m) => ({
        segment: m.segment,
        change_pct: Number(m.changePct.toFixed(1)),
        total: m.total,
      })),
    })),
    new_tags: agg.newTags.slice(0, 10).map((t) => ({ tag: t.tag, count: t.total_count })),
  }
}

export async function generateInsight(agg: WeeklyAggregate): Promise<InsightResult> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set')

  const data = compactAggregate(agg)
  const allZero = data.buckets.every((b) => b.segments.every((s) => s.total === 0))
  if (allZero) {
    return { text: '이번 주 수집된 데이터가 없습니다.', costUsd: 0 }
  }

  const client = new OpenAI({ apiKey })
  const system =
    '당신은 글로벌 개발자 채용 시장의 주간 변화를 분석합니다. ' +
    '데이터에는 여러 source bucket("global", "adzuna" 등)이 있으며, ' +
    'Adzuna는 국가별로 중복 집계되므로 bucket 간 합산하지 말고 bucket 내에서만 비교하세요. ' +
    '한국어로 한 문단만 작성합니다. 3~5문장, 200자 내외. ' +
    '개별 수치보다는 방향성(증가/감소/신규 카테고리 출현)에 집중하고, ' +
    '중립적인 보고 어조. 마케팅 표현·이모지·목록 금지.'

  const user =
    '아래는 이번 주 채용 공고 집계 데이터(JSON)입니다. 한 문단의 인사이트를 작성하세요.\n\n' +
    JSON.stringify(data, null, 2)

  const res = await client.chat.completions.create({
    model: MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  })

  const parsed = InsightResponseSchema.parse(res)
  const first = parsed.choices[0]!
  const text = first.message.content.trim()
  const inTok = parsed.usage?.prompt_tokens ?? 0
  const outTok = parsed.usage?.completion_tokens ?? 0
  return { text, costUsd: estimateCost(inTok, outTok) }
}
