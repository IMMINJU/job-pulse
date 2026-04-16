export async function notifyFailure(context: string, err: unknown): Promise<void> {
  const url = process.env.FAILURE_WEBHOOK_URL ?? process.env.GOOGLE_CHAT_WEBHOOK_URL
  if (!url) {
    console.error('(no webhook configured; skipping failure alert)')
    return
  }
  const summary = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
  const stack = err instanceof Error && err.stack ? err.stack.split('\n').slice(0, 6).join('\n') : ''
  const text = [`*job-pulse failure* — ${context}`, '```', summary, stack, '```'].filter(Boolean).join('\n')

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ text }),
    })
    if (!res.ok) {
      console.error(`failure webhook ${res.status} ${res.statusText}`)
    }
  } catch (sendErr) {
    console.error('failed to send failure alert:', sendErr)
  }
}
