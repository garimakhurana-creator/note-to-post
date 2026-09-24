const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Everything - notes, drafts, the Telegram polling offset - is one JSON
// document. On Vercel it lives in Upstash Redis (the env vars the Vercel
// Upstash integration injects); locally it falls back to data/store.json.
// It is a single-user app, so read-modify-write on one key is enough.

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const REDIS_KEY = process.env.STORE_KEY || 'note-to-post:store';

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'store.json');

const EMPTY = () => ({ notes: [], drafts: [], telegramOffset: 0 });

async function redis(command) {
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${REDIS_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(command)
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(`Storage: ${data.error || res.status}`);
  return data.result;
}

function parse(raw) {
  if (!raw) return EMPTY();
  try {
    return { ...EMPTY(), ...JSON.parse(raw) };
  } catch {
    return EMPTY();
  }
}

async function load() {
  if (REDIS_URL) return parse(await redis(['GET', REDIS_KEY]));
  if (!fs.existsSync(DATA_FILE)) return EMPTY();
  return parse(fs.readFileSync(DATA_FILE, 'utf-8'));
}

async function save(data) {
  const json = JSON.stringify(data);
  if (REDIS_URL) return redis(['SET', REDIS_KEY, json]);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

// Read-modify-write in one call so callers can't forget to save.
async function update(fn) {
  const data = await load();
  const result = fn(data);
  await save(data);
  return result;
}

function newId(prefix) {
  return `${prefix}-${crypto.randomBytes(4).toString('hex')}`;
}

module.exports = { load, save, update, newId, backend: REDIS_URL ? 'redis' : 'file' };
