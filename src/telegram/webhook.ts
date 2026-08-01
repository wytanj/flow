/**
 * Telegram bot — flow in your pocket.
 *
 * Dormant until TELEGRAM_BOT_TOKEN is set; the route stays mounted either way
 * so turning it on is configuration, not a deploy. Text the bot and it captures;
 * start with "?" and it answers from what you have told it.
 *
 * Setup, once you have a token from @BotFather:
 *   1. set TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET (any long random string)
 *   2. npm run telegram:register -- https://<your-deployment>/telegram/webhook
 *   3. message the bot; it will reply with your chat id
 *   4. set TELEGRAM_ALLOWED_CHAT_IDS to that id and redeploy
 */
import { ask } from '../ai/ask.js'
import { smartCapture } from '../ai/extract.js'
import * as flow from '../core/flow.js'
import { formatList } from '../core/format.js'
import { logged } from '../core/prompts.js'

export function telegramEnabled(): boolean {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN)
}

interface TelegramUpdate {
  message?: {
    text?: string
    chat?: { id?: number }
    from?: { first_name?: string }
  }
}

async function send(chatId: number, text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) return
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: text.length > 4000 ? `${text.slice(0, 3990)}\n…` : text,
      parse_mode: 'Markdown',
      link_preview_options: { is_disabled: true },
    }),
  }).catch((err) => console.error('[flow:telegram] send failed:', err))
}

/**
 * An open bot is an open write endpoint into someone's private memory, so the
 * allowlist is mandatory: with none configured every chat is refused, and the
 * refusal tells you the id to allow.
 */
function isAllowed(chatId: number): boolean {
  const allowed = (process.env.TELEGRAM_ALLOWED_CHAT_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return allowed.includes(String(chatId))
}

export async function handleTelegramUpdate(update: TelegramUpdate): Promise<void> {
  const message = update.message
  const chatId = message?.chat?.id
  const text = message?.text?.trim()
  if (!chatId || !text) return

  if (!isAllowed(chatId)) {
    await send(
      chatId,
      `This bot is private.\n\nIf it is yours, add this chat id to TELEGRAM_ALLOWED_CHAT_IDS:\n\`${chatId}\``,
    )
    return
  }

  try {
    // "?" prefix or /ask asks; everything else is captured. Capture is the
    // default because the cost of a missed thought is higher than a stray entry.
    if (text.startsWith('?') || text.startsWith('/ask')) {
      const question = text.replace(/^(\?|\/ask)\s*/, '')
      if (!question) return void (await send(chatId, 'Ask me something about what you have saved.'))
      const res = await logged({ surface: 'telegram', action: 'ask', input: question }, () => ask(question))
      return void (await send(chatId, res.answer))
    }

    if (text === '/brief' || text === '/start') {
      const b = await flow.briefing()
      const lines = [`*flow* — ${b.stats.total} memories, ${b.stats.captured_last_7_days} this week`]
      if (b.due.length) lines.push(`\n*Due*\n${formatList(b.due)}`)
      if (b.open_tasks.length) lines.push(`\n*Open*\n${formatList(b.open_tasks)}`)
      if (b.watchlist.length) lines.push(`\n*Watchlist*\n${formatList(b.watchlist)}`)
      lines.push('\nSend anything to remember it. Start with `?` to ask.')
      return void (await send(chatId, lines.join('\n')))
    }

    if (text === '/watchlist') {
      return void (await send(chatId, formatList(await flow.open('movie'), 'Watchlist is empty.')))
    }

    if (text === '/due') {
      return void (await send(chatId, formatList(await flow.due(7), 'Nothing due.')))
    }

    const { entries, duplicates } = await logged(
      { surface: 'telegram', action: 'telegram_capture', input: text },
      () => smartCapture(text, 'telegram'),
      (r) => r.entries,
    )
    const summary = entries
      .map((e) => `• *${e.title ?? 'untitled'}* — ${e.kind}${e.status ? ` · ${e.status}` : ''}`)
      .join('\n')
    const dupeNote = duplicates.length ? '\n\n_Similar entries already exist._' : ''
    await send(chatId, `Saved ${entries.length > 1 ? `${entries.length} things` : 'it'}:\n${summary}${dupeNote}`)
  } catch (err) {
    console.error('[flow:telegram] handler failed:', err)
    await send(chatId, `Something went wrong: ${err instanceof Error ? err.message : 'unknown error'}`)
  }
}
