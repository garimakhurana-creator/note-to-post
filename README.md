# Note to Post

Meera keeps dropping notes into Telegram. This bot reads each one, decides whether it's worth a post, and if it is, drafts a LinkedIn post in her voice with a current news angle and sends it back to her in the same chat.

**It never posts anything.** Both no-code proposals Meera turned down did the whole job end to end. This one stops at the draft: she copies it to LinkedIn herself.

## In the chat

| She does | The bot does |
|---|---|
| Sends a note (text or voice) | Transcribes voice, sorts it against the voice guide. Worth a post: says why, drafts it (about 2 min). Not worth one: says why in one line. |
| Replies **draft** to a note, or to a "Not drafting" message | Drafts it anyway |
| Replies to a draft with feedback, or with the real numbers for the `[brackets]` | Sends a new version |

Each draft arrives as two messages. The **post alone**, so it copies cleanly, then **About this draft**: the news source, what to fill in, any made-up details the checker took out, voice-check results and the drafter's notes.

## How a draft is made

1. **Triage** (Gemini, JSON): develop / hold / skip, scored 1-10. Only `develop` at `MIN_SCORE` (default 7) or higher is drafted. With no weekly queue, this filter is what keeps it near 3 posts a week.
2. **Draft** (Gemini + Google Search grounding): one recent news item or data point, the post, notes for Meera. Sources come from grounding metadata, not the model's text. No source means one retry that insists on searching. A cut-off draft is retried with a bigger budget, never sent.
3. **Invented-detail check**: anything about Skinstinct, Meera or the customer that her note doesn't state becomes a `[placeholder]`.
4. **Voice lint** (`lib/voice-lint.js`): dashes, semicolons, `!`, hashtags, emojis, banned words, CTAs, US spelling, broetry, spelled-out numbers, cut-off endings. Hard failures get one automatic fix pass.

Nothing is stored. A redraft works because her reply carries the draft it's replying to.

## Deploy (Vercel)

Env vars: `GEMINI_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_WEBHOOK_SECRET`, optional `GEMINI_MODEL`, `MIN_SCORE`.

After deploying, point the bot at it:

```bash
node scripts/set-webhook.js https://<your-app>.vercel.app
```

`GET /api/health` shows which settings the deployed app can see.

## Local

`cp .env.example .env`, fill it in, `npm install && npm start`. Locally it long-polls Telegram instead, but refuses to while a webhook is set, so it never takes messages from the deployed bot. `npm test` runs the lint and message tests.

## Files

- `lib/bot.js` routes chat messages and formats replies
- `lib/pipeline.js` has the transcribe, triage, draft, invented-detail and revise prompts
- `lib/voice-lint.js` checks the voice guide's hard rules
- `lib/telegram.js` and `lib/gemini.js` are thin API wrappers
- `voice-guide.txt` is Meera's voice guide. Edit it and redeploy to change the rules.
