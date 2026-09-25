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

1. **Score** (Gemini Flash): 0-10 with a one-line reason. Below `MIN_SCORE` (default 6), she gets the reason and no draft. With no weekly queue, this filter is what keeps it near 3 posts a week.
2. **News angle**: Gemini Flash pulls 3-5 search terms from the note. Google News RSS (free, no key) returns recent results, widening the search until something comes back.
3. **Draft** (Gemini Pro, with `voice-guide.txt`): the drafter gets the note plus the top news results. It uses one only if it fits naturally, and says which.
4. **Verify flag**: any draft that uses a news item ends with the `NEWS SOURCE / FROM / LINK / ⚠ Check this before publishing` block. She checks the claim, then deletes the block before posting.
5. **Invented-detail check**: anything about Skinstinct, Meera or the customer that her note doesn't state becomes a `[placeholder]`.
6. **Voice lint** (`lib/voice-lint.js`): dashes, semicolons, `!`, hashtags, emojis, banned words, CTAs, US spelling, broetry, spelled-out numbers, cut-off endings. Hard failures get one automatic fix pass. The verify block isn't linted.

Nothing is stored. A redraft works because her reply carries the draft it's replying to, verify block included, so it keeps the same news item.

## Deploy (Vercel)

Env vars: `GEMINI_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_WEBHOOK_SECRET`, optional `GEMINI_MODEL` (drafting), `GEMINI_FAST_MODEL` (scoring and keywords), `MIN_SCORE`.

After deploying, point the bot at `/api/webhook`:

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
- `lib/news.js` searches Google News RSS
- `lib/telegram.js` and `lib/gemini.js` are thin API wrappers
- `voice-guide.txt` is Meera's voice guide. Edit it and redeploy to change the rules.
