/**
 * Points your Telegram bot at a deployed flow.
 *
 *   npm run telegram:register -- https://your-app.vercel.app/telegram/webhook
 *
 * Reads TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET from .env. The secret is
 * echoed back by Telegram on every update, and the webhook route rejects
 * anything without it — otherwise the URL alone would be enough for anyone to
 * write into your memory.
 */
import { config } from 'dotenv'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
config({ path: join(root, '.env'), quiet: true })

const url = process.argv[2]
const token = process.env.TELEGRAM_BOT_TOKEN
const secret = process.env.TELEGRAM_WEBHOOK_SECRET

if (!url) {
  console.error('Usage: npm run telegram:register -- https://<deployment>/telegram/webhook')
  process.exit(1)
}
if (!token || !secret) {
  console.error('Set TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET in .env first.')
  console.error("  node -e \"console.log(require('crypto').randomBytes(24).toString('hex'))\"")
  process.exit(1)
}

const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    url,
    secret_token: secret,
    allowed_updates: ['message'],
    drop_pending_updates: true,
  }),
})
const json = await res.json()
console.log(json.ok ? `Webhook set: ${url}` : `Failed: ${JSON.stringify(json)}`)

if (json.ok) {
  const me = await (await fetch(`https://api.telegram.org/bot${token}/getMe`)).json()
  console.log(`Bot: @${me.result?.username}`)
  console.log('\nMessage it now. It will reply with your chat id — put that in')
  console.log('TELEGRAM_ALLOWED_CHAT_IDS (and in Vercel env), then redeploy.')
}
process.exit(json.ok ? 0 : 1)
