// Points the Telegram bot at a deployed URL: node scripts/set-webhook.js https://app.vercel.app
// Reads TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET from the environment.
const telegram = require('../lib/telegram');

const base = (process.argv[2] || '').replace(/\/$/, '');
if (!base.startsWith('https://')) {
  console.error('Usage: node scripts/set-webhook.js https://<your-app>.vercel.app');
  process.exit(1);
}
if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_WEBHOOK_SECRET) {
  console.error('Set TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET first.');
  process.exit(1);
}
telegram.setWebhook(`${base}/api/webhook`, process.env.TELEGRAM_WEBHOOK_SECRET)
  .then(() => console.log(`Webhook set: ${base}/api/webhook`))
  .catch(err => { console.error(err.message); process.exit(1); });
