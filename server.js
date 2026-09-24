const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

loadDotEnv();

const store = require('./lib/store');
const pipeline = require('./lib/pipeline');
const telegram = require('./lib/telegram');

// The same app runs two ways:
//  - locally (`npm start`): listens on PORT, long-polls Telegram, ticks every 15 min
//  - on Vercel (api/index.js): Telegram posts to /api/telegram, Vercel Cron hits /api/cron
const ON_VERCEL = Boolean(process.env.VERCEL);
const PORT = process.env.PORT || 3300;
const TICK_MS = 15 * 60 * 1000;

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Same loader as sales-intel-app: reads .env without a dotenv dependency and
// copes with Notepad's UTF-16 files. Shell env vars win.
function loadDotEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const buf = fs.readFileSync(envPath);
  let raw;
  if (buf[0] === 0xff && buf[1] === 0xfe) raw = buf.toString('utf16le');
  else if (buf[0] === 0xfe && buf[1] === 0xff) raw = buf.swap16().toString('utf16le');
  else raw = buf.toString('utf8');
  raw.replace(/^﻿/, '').split('\n').forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const eq = trimmed.indexOf('=');
    if (eq === -1) return;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  });
}

// Keeps work going after the response is sent. On Vercel the function would
// otherwise be frozen the moment we reply to Telegram.
function inBackground(promise) {
  const safe = promise.catch(err => console.error(`Background task failed: ${err.message}`));
  if (ON_VERCEL) require('@vercel/functions').waitUntil(safe);
}

const wrap = fn => async (req, res) => {
  try {
    res.json(await fn(req, res));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
};

const httpError = (status, message) => Object.assign(new Error(message), { status });
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
};

// ---------------------------------------------------------------- machine-to-machine routes
// These authenticate with their own secrets, not the review-page password.

// Telegram pushes every message here. We store it, reply 200 fast, and sort
// it in the background so Telegram never retries a slow request.
app.post('/api/telegram', async (req, res) => {
  if (!safeEqual(req.get('x-telegram-bot-api-secret-token'), process.env.TELEGRAM_WEBHOOK_SECRET)) {
    return res.status(401).end();
  }
  try {
    const raw = await telegram.toNote(req.body || {});
    if (raw) {
      const note = await pipeline.ingest(raw, 'telegram');
      console.log(`Telegram: new ${note.kind} note ${note.id}`);
      if (note.status === 'new') inBackground(pipeline.triagePending());
    }
  } catch (err) {
    console.error(`Telegram webhook: ${err.message}`);
  }
  res.json({ ok: true });
});

// Vercel Cron calls this once a day with `Authorization: Bearer $CRON_SECRET`.
app.get('/api/cron', wrap(async req => {
  if (!safeEqual(req.get('authorization'), `Bearer ${process.env.CRON_SECRET}`)) throw httpError(401, 'Unauthorised.');
  return pipeline.tick();
}));

// ---------------------------------------------------------------- review-page password
// The review page is on the public internet once deployed. One shared
// password, checked once, then remembered in an HttpOnly cookie.

const sessionToken = () => crypto.createHmac('sha256', process.env.APP_PASSWORD || '').update('note-to-post-session').digest('hex');

function readCookie(req, name) {
  const match = (req.get('cookie') || '').split(/;\s*/).find(c => c.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

app.post('/api/login', wrap((req, res) => {
  if (!process.env.APP_PASSWORD) return { ok: true };
  if (!safeEqual(req.body?.password, process.env.APP_PASSWORD)) throw httpError(401, 'Wrong password.');
  res.setHeader('Set-Cookie', `ntp_session=${sessionToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 90}${ON_VERCEL ? '; Secure' : ''}`);
  return { ok: true };
}));

app.use('/api', (req, res, next) => {
  if (!process.env.APP_PASSWORD) {
    // Deployed without a password would expose everything - refuse instead.
    if (ON_VERCEL) return res.status(503).json({ error: 'APP_PASSWORD is not set on the server.' });
    return next();
  }
  if (safeEqual(readCookie(req, 'ntp_session'), sessionToken())) return next();
  res.status(401).json({ error: 'login required' });
});

// ---------------------------------------------------------------- review-page API

app.get('/api/state', wrap(async () => {
  const data = await store.load();
  return {
    notes: data.notes.map(({ audio, ...n }) => n).reverse(),
    drafts: [...data.drafts].reverse(),
    cadence: await pipeline.cadence(data),
    config: {
      gemini: Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY),
      telegram: Boolean(process.env.TELEGRAM_BOT_TOKEN),
      telegramChat: Boolean(process.env.TELEGRAM_CHAT_ID),
      storage: store.backend
    }
  };
}));

// Paste a note by hand - for notes that didn't come through Telegram.
app.post('/api/notes', wrap(async req => {
  const text = (req.body?.text || '').trim();
  if (!text) throw httpError(400, 'Note text is empty.');
  return pipeline.receive({ text }, 'web');
}));

app.post('/api/triage', wrap(() => pipeline.triagePending()));

// Meera overrides the filter: promote a held note, or skip one it liked.
app.post('/api/notes/:id/verdict', wrap(req => {
  const verdict = req.body?.verdict;
  if (!['develop', 'hold', 'skip'].includes(verdict)) throw httpError(400, 'Bad verdict.');
  return store.update(data => {
    const note = data.notes.find(n => n.id === req.params.id);
    if (!note) throw httpError(404, 'Note not found.');
    const t = note.triage || {};
    // Meera's own "develop" picks go to the front of the scheduler's queue.
    note.triage = { ...t, filterVerdict: t.filterVerdict || t.verdict || null, verdict, score: verdict === 'develop' ? 10 : t.score || 0, overriddenByMeera: true };
    if (note.status === 'new') note.status = 'triaged';
    return note;
  });
}));

app.post('/api/notes/:id/draft', wrap(req => pipeline.draftNote(req.params.id, { trigger: 'manual' })));

// Save Meera's edits and re-run the voice checks on them.
app.put('/api/drafts/:id', wrap(req => store.update(data => {
  const draft = data.drafts.find(d => d.id === req.params.id);
  if (!draft) throw httpError(404, 'Draft not found.');
  if (typeof req.body?.post === 'string') {
    draft.post = req.body.post;
    draft.lint = pipeline.lint(draft.post);
    draft.editedAt = new Date().toISOString();
  }
  if (['ready', 'approved', 'rejected'].includes(req.body?.status)) {
    draft.status = req.body.status;
    draft[`${req.body.status}At`] = new Date().toISOString();
  }
  return draft;
})));

// Redraft with Meera's feedback. The old draft is kept and marked replaced.
app.post('/api/drafts/:id/redraft', wrap(async req => {
  const feedback = (req.body?.feedback || '').trim();
  if (!feedback) throw httpError(400, 'Say what to change.');
  const old = (await store.load()).drafts.find(d => d.id === req.params.id);
  if (!old) throw httpError(404, 'Draft not found.');
  const draft = await pipeline.draftNote(old.noteId, { feedback, trigger: 'redraft' });
  await store.update(data => {
    const d = data.drafts.find(x => x.id === old.id);
    d.status = 'replaced';
    d.replacedBy = draft.id;
  });
  return draft;
}));

// Runs the scheduler step now instead of waiting for the next tick.
app.post('/api/tick', wrap(() => pipeline.tick({ force: true })));

module.exports = app;

if (require.main === module) {
  const server = app.listen(PORT, () => {
    console.log(`Note-to-post running at http://localhost:${PORT} (storage: ${store.backend})`);
    telegram.startPolling({
      onNote: async raw => {
        const note = await pipeline.receive(raw, 'telegram');
        console.log(`Telegram: new ${note.kind} note ${note.id}`);
      },
      getOffset: async () => (await store.load()).telegramOffset || 0,
      setOffset: offset => store.update(data => { data.telegramOffset = offset; })
    });
    if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) {
      setTimeout(() => pipeline.tick(), 5000);
      setInterval(() => pipeline.tick(), TICK_MS);
    } else {
      console.log('GEMINI_API_KEY not set - triage and drafting are off until it is.');
    }
  });
  // Drafting runs several grounded searches - give it room.
  server.timeout = 5 * 60 * 1000;
}
