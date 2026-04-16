import type { Notifier, ReportMessage } from './index.ts'

function renderPlainText(msg: ReportMessage): string {
  const lines: string[] = [`*${msg.title}*`, '']
  if (msg.summary) lines.push(msg.summary, '')
  for (const s of msg.sections) {
    if (s.heading) lines.push(`*${s.heading}*`)
    if (s.mono) lines.push('```', s.body, '```', '')
    else lines.push(s.body, '')
  }
  if (msg.footer) lines.push(`_${msg.footer}_`)
  return lines.join('\n').trim()
}

export function makeGChatNotifier(webhookUrl: string): Notifier {
  return {
    name: 'google_chat',
    async send(message: ReportMessage): Promise<void> {
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=UTF-8' },
        body: JSON.stringify({ text: renderPlainText(message) }),
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`gchat webhook ${res.status} ${res.statusText}: ${body.slice(0, 200)}`)
      }
    },
  }
}
