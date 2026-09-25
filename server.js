const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

loadDotEnv();

const bot = require('./lib/bot');
const telegram = require('./lib/telegram');

// Runs two ways:
//  - on Vercel (api/index.js): Telegram posts each message to /api/webhook
//  - locally (`npm start`): long-polls Telegram, same handler
const ON_VERCEL = Boolean(process.env.VERCEL);

const app = express();
app.use(express.json({ limit: '1mb' }));

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

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
};

// Telegram posts every message here. Reply 200 at once - drafting takes a
// couple of minutes and Telegram would otherwise retry and double-post - and
// keep working in the background.
// /api/webhook is the address in the case plan; /api/telegram is kept so an
// existing webhook keeps working.
app.post(['/api/webhook', '/api/telegram'], (req, res) => {
  if (!safeEqual(req.get('x-telegram-bot-api-secret-token'), process.env.TELEGRAM_WEBHOOK_SECRET)) {
    return res.status(401).end();
  }
  const work = bot.handleUpdate(req.body || {});
  if (ON_VERCEL) require('@vercel/functions').waitUntil(work);
  res.json({ ok: true });
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    gemini: Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY),
    telegram: Boolean(process.env.TELEGRAM_BOT_TOKEN),
    chat: Boolean(process.env.TELEGRAM_CHAT_ID),
    webhookSecret: Boolean(process.env.TELEGRAM_WEBHOOK_SECRET)
  });
});

module.exports = app;

if (require.main === module) {
  telegram.startPolling(bot.handleUpdate);
}
