import { parseArgs } from 'node:util'
import { loadConfig } from './config.ts'
import { buildWeeklyAggregate } from './report/aggregate.ts'
import { generateInsight } from './report/insight.ts'
import { buildReportMessage } from './report/format.ts'
import { findReportRun, upsertReportRun } from './db/queries.ts'
import { makeNotifier } from './notifier/factory.ts'
import { notifyFailure } from './notifier/failure.ts'

function renderConsole(msg: ReturnType<typeof buildReportMessage>): string {
  const lines = [`# ${msg.title}`, '']
  if (msg.summary) lines.push(msg.summary, '')
  for (const s of msg.sections) {
    if (s.heading) lines.push(`## ${s.heading}`)
    lines.push(s.body, '')
  }
  if (msg.footer) lines.push(msg.footer)
  return lines.join('\n')
}

async function main() {
  const { values } = parseArgs({
    options: {
      send: { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
    },
  })

  const cfg = loadConfig()
  const now = new Date()

  const agg = await buildWeeklyAggregate(now, {
    newTagMinCount: cfg.report.new_tag.min_count,
    segments: cfg.segments.map((s) => s.key),
  })

  const existing = await findReportRun(agg.weekStart)
  if (existing?.sent && !values.force) {
    console.log(`report for ${agg.weekStart} already sent. use --force to re-send.`)
    return
  }

  const insight = await generateInsight(agg)
  const message = buildReportMessage(agg, insight.text)

  console.log(renderConsole(message))
  console.log(`\n---\nestimated LLM cost: $${insight.costUsd?.toFixed(6) ?? 'n/a'}`)

  if (!values.send) {
    console.log('(dry run — pass --send to deliver)')
    await upsertReportRun({
      week_start: agg.weekStart,
      payload: message,
      sent: false,
      insight_cost: insight.costUsd ?? null,
    })
    return
  }

  const notifier = makeNotifier(cfg.notifier)
  await notifier.send(message)
  await upsertReportRun({
    week_start: agg.weekStart,
    payload: message,
    sent: true,
    insight_cost: insight.costUsd ?? null,
  })
  console.log(`sent via ${notifier.name}`)
}

main().catch(async (err) => {
  console.error(err)
  await notifyFailure('report:main', err)
  process.exit(1)
})
