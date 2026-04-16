import type { Config } from '../config.ts'
import type { Notifier } from './index.ts'
import { makeGChatNotifier } from './gchat.ts'

export function makeNotifier(cfg: Config['notifier']): Notifier {
  const url = process.env[cfg.webhook_url_env]
  if (!url) throw new Error(`${cfg.webhook_url_env} is not set`)
  switch (cfg.type) {
    case 'google_chat':
      return makeGChatNotifier(url)
    case 'slack':
    case 'webhook':
      throw new Error(`notifier type "${cfg.type}" is not implemented yet`)
  }
}
