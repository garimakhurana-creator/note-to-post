# Note to Post

Meera keeps dropping notes into Telegram. This app picks them up, decides which are worth a post, drafts a LinkedIn post in her voice with a current news angle, and holds it for her review. It aims for three drafts a week.

**It never posts anything.** Both no-code proposals Meera turned down did the whole job end to end. This one does every step except the last. A draft reaches LinkedIn only when she copies it there herself.

## Flow

```
Telegram note (text or voice)
  -> ingest          voice notes transcribed by Gemini
  -> triage          develop / hold / skip + reason, judged against voice=skill.txt
                     (Meera can override any verdict)
  -> draft           Mon/Wed/Fri 08:00, best "develop" note, until 3 this week
                       - Google Search grounding finds one recent news item / data point
                       - post written to the voice guide, Skinstinct numbers left as [placeholders]
                       - voice lint (dashes, semicolons, !, hashtags, emojis, banned words,
                         CTAs, US spelling, broetry); one auto-fix pass on hard failures
  -> Telegram ping   "Draft 2/3 this week is ready" + link
  -> review page     edit (lint re-runs), redraft with feedback, reject, or copy & mark posted
```

If no note is strong enough on a draft day, it says so instead of forcing a weak post.

## Deployed on Vercel

| Piece | How it runs |
|---|---|
| Review page | `public/`, served as static files. `/api/*` goes to `api/index.js` (the Express app in `server.js`) |
| Telegram | webhook at `/api/telegram`, checked against `TELEGRAM_WEBHOOK_SECRET` |
| Schedule | Vercel Cron hits `/api/cron` daily at 02:30 UTC (08:00 IST) and drafts on `DRAFT_DAYS` |
| Storage | Upstash Redis (Vercel Marketplace), one JSON document |
| Access | `APP_PASSWORD`, remembered in a cookie for 90 days |

Env vars to set in the Vercel project: `GEMINI_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `APP_PASSWORD`, `TELEGRAM_WEBHOOK_SECRET`, `CRON_SECRET`, `PUBLIC_URL`. Connecting Upstash adds the `KV_REST_API_*` ones.

After the first deploy, point the bot at it:

```bash
node scripts/set-webhook.js https://<your-app>.vercel.app
```

## Running locally

`cp .env.example .env`, fill in `GEMINI_API_KEY` and `TELEGRAM_BOT_TOKEN`, then `npm install && npm start` and open http://localhost:3300. Locally it stores data in `data/store.json` and long-polls Telegram. If the bot already has a webhook (i.e. the deployed app owns it), local polling steps aside rather than stealing messages from production.

## Files

- `lib/pipeline.js` holds the ingest, triage and draft prompts and the cadence scheduler
- `lib/voice-lint.js` checks the voice guide's hard rules (tests in `test/`)
- `lib/telegram.js` handles long polling, voice-file download and pings
- `lib/gemini.js` wraps `generateContent`; cited sources come from grounding metadata, not from the model's text
- `lib/store.js` stores notes and drafts in Upstash Redis when deployed, `data/store.json` locally

The drafter follows `voice-guide.txt`. Edit it and redeploy to change the voice rules.
