const fs = require('fs');
const path = require('path');
const store = require('./store');
const { generate, parseJson } = require('./gemini');
const { lint } = require('./voice-lint');
const telegram = require('./telegram');

// The voice guide ships with the app (voice-guide.txt) so the deployed
// drafter follows whatever version is checked in.
function loadVoiceGuide() {
  const p = process.env.VOICE_GUIDE_PATH || path.join(__dirname, '..', 'voice-guide.txt');
  return fs.readFileSync(p, 'utf-8');
}

const today = () => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------- ingest

async function transcribe(audio) {
  const { text } = await generate({
    system: 'Transcribe this voice note verbatim in English. Output only the transcript, no commentary.',
    parts: [{ inlineData: { mimeType: audio.mimeType, data: audio.base64 } }],
    maxTokens: 8000
  });
  return text;
}

async function ingest(raw, source = 'telegram') {
  const note = {
    id: store.newId('note'),
    source,
    kind: raw.kind || 'text',
    text: raw.text || '',
    forwardedFrom: raw.forwardedFrom || null,
    receivedAt: raw.receivedAt || new Date().toISOString(),
    status: 'new',
    triage: null
  };
  if (raw.audio) {
    try {
      const transcript = await transcribe(raw.audio);
      note.text = [raw.text, transcript].filter(Boolean).join('\n\n');
    } catch (err) {
      note.status = 'error';
      note.error = `Voice note could not be transcribed: ${err.message}`;
    }
  }
  await store.update(data => { data.notes.push(note); });
  return note;
}

// A new note is sorted as soon as it lands, so the Notes tab is always
// current and the scheduler only has to pick from already-sorted notes.
async function receive(raw, source) {
  const note = await ingest(raw, source);
  if (note.status === 'new') await triagePending();
  return note;
}

// ---------------------------------------------------------------- triage

const TRIAGE_SYSTEM = voice => `You are the editorial filter for Meera Pillai, founder of Skinstinct, an Indian skincare brand. She drops raw notes into Telegram all week. Your job is to decide which notes are worth turning into a LinkedIn post in her voice, so she does not have to.

Her voice guide is below. Judge each note against it.

A note is worth DEVELOPING when it has at least one of:
- a specific observation, number, test result, customer question or scene she witnessed
- a gap between what a label/marketing claim says and what the chemistry or data shows
- a mistake or unflattering data point from Skinstinct she could publish honestly
- a regulatory, sourcing or manufacturing detail most readers don't know
and it can be written without her personal life (family, health, her own skin, money worries, burnout are off limits - see 2G).

HOLD a note when the idea is promising but too thin on its own (no specific detail yet), or it needs data only Meera has. SKIP to-dos, reminders, links with no comment, personal items, pure product promotion, and anything that would need hype or a banned claim to work.

Do not invent Skinstinct numbers. If a post would need one, say so in needsFromMeera.

Return JSON only: {"results":[{"id":"...","verdict":"develop|hold|skip","score":1-10,"reason":"one sentence","angle":"one sentence: the post's core claim","hook":"which of her 5 opening mechanisms fits","newsSearch":"what kind of current news or industry data point would make this timely (a search brief)","needsFromMeera":["..."]}]}

=== VOICE GUIDE ===
${voice}`;

async function triagePending() {
  const pending = (await store.load()).notes.filter(n => n.status === 'new' && n.text.trim());
  if (!pending.length) return [];

  const payload = pending.map(n => ({ id: n.id, received: n.receivedAt, forwardedFrom: n.forwardedFrom, note: n.text }));
  const { text } = await generate({
    system: TRIAGE_SYSTEM(loadVoiceGuide()),
    parts: [{ text: `Today is ${today()}. Triage these notes:\n\n${JSON.stringify(payload, null, 2)}` }],
    json: true,
    maxTokens: 16000
  });
  const results = parseJson(text).results || [];

  return store.update(data => {
    const updated = [];
    for (const r of results) {
      const note = data.notes.find(n => n.id === r.id && n.status === 'new');
      if (!note) continue;
      note.triage = {
        verdict: ['develop', 'hold', 'skip'].includes(r.verdict) ? r.verdict : 'hold',
        score: Number(r.score) || 0,
        reason: r.reason || '',
        angle: r.angle || '',
        hook: r.hook || '',
        newsSearch: r.newsSearch || '',
        needsFromMeera: Array.isArray(r.needsFromMeera) ? r.needsFromMeera : [],
        at: new Date().toISOString()
      };
      note.status = 'triaged';
      updated.push(note);
    }
    return updated;
  });
}

// ---------------------------------------------------------------- draft

const DRAFT_SYSTEM = voice => `You draft LinkedIn posts for Meera Pillai, founder of Skinstinct. Every draft goes to Meera for review before anything is posted - you are writing a first draft for her to edit, not a finished post.

Follow the voice guide below exactly. The hard rules, restated because they are the ones drafts break most:
- No em-dashes, en-dashes, semicolons, exclamation marks, hashtags or emojis. Use a spaced hyphen ( - ) for asides.
- No rhetorical-question hooks. Open with one of her five mechanisms (2A).
- Paragraphs of 3-7 sentences. Only short verdicts stand alone. No one-line-per-sentence LinkedIn style.
- British/Indian spelling. Numerals for all measurements.
- No banned words (2F) except inside double quotes to take them apart.
- Close with a question for the reader to ask, a test, or a practical step. Never a CTA, link or pitch.
- NEVER invent Skinstinct data or details of what happened (returns, batch results, customer counts, pH, expiry or PAO of her products, test results, when an email arrived, dates of her own meetings). Only what the note says is known. Where the post needs one, write a [square-bracket placeholder] describing exactly what number goes there.
- 180-320 words.

THE CURRENT ANGLE: use Google Search to find ONE recent item (ideally from the last 60 days, today is ${today()}) that makes this post timely: a news story, a regulatory update (CDSCO, BIS, Indian labelling rules, EU/US moves that affect Indian brands), a published study, or an industry data point. Prefer Indian context. Reference it the way she would - specifically, with who published it and when, and without overstating what it found. If nothing current genuinely connects, say so in the ANGLE section and write the post without forcing one. Never fabricate a source.

Output exactly these three sections and nothing else:
===ANGLE===
2-4 sentences: what the current item is, who published it, the date, and how it connects to the note.
===POST===
The post text only.
===FOR_MEERA===
Short bullet list: what she should verify, which placeholders need her numbers, and anything in the note you chose to leave out and why.

=== VOICE GUIDE ===
${voice}`;

function parseSections(text) {
  const grab = name => {
    const m = text.match(new RegExp(`===${name}===\\s*([\\s\\S]*?)(?====[A-Z_]+===|$)`));
    return m ? m[1].trim() : '';
  };
  return { angle: grab('ANGLE'), post: grab('POST'), forMeera: grab('FOR_MEERA') };
}

// One automatic clean-up pass for hard voice-rule breaks, so Meera sees a
// draft that already passes the mechanical checks.
async function revise(post, issues, voice) {
  const list = issues.filter(i => i.severity === 'error').map(i => `- ${i.rule}: ${i.detail}`).join('\n');
  const { text, truncated } = await generate({
    system: `You edit LinkedIn drafts to match Meera Pillai's voice guide. Change only what is needed to fix the listed problems. Keep every [placeholder], fact and source reference. Output the corrected post text only.\n\n=== VOICE GUIDE ===\n${voice}`,
    parts: [{ text: `Fix these problems:\n${list}\n\nDraft:\n${post}` }],
    maxTokens: 12000
  });
  return text && !truncated ? text : post;
}

// The drafter is told not to invent Skinstinct facts but still does
// ("our serum's expiry is 24 months", "last Tuesday"). A separate pass checks
// the post against the note and turns anything about Skinstinct or Meera
// that the note doesn't support into a placeholder.
async function checkInventions(post, noteText) {
  const { text, truncated } = await generate({
    system: `You fact-check LinkedIn drafts written for Meera Pillai, founder of Skinstinct. The note is the ONLY source of truth about Skinstinct, Meera and her customers. Be strict.

Go through the draft sentence by sentence. Flag any detail the note does not literally state about:
- when something happened ("on Tuesday", "last week", "this morning")
- what a customer said, saw or did beyond the note ("the expiry was 14 months away", "she checked the label")
- Skinstinct's products, specs, numbers, tests, methods or processes ("our mid-batch sampling", "we test at 40C", "our serum")
- decisions or alternatives Meera considered ("we could have printed 12 months")
General chemistry, industry facts and the cited news item are NOT flagged.

For each flagged detail, replace just those words with a [square-bracket placeholder] naming what Meera must supply, or delete the clause if the sentence reads fine without it. Change nothing else. Keep placeholders already in the draft. Return JSON only: {"post":"the corrected post","changes":[{"removed":"exact words removed","placeholder":"[the placeholder] or (deleted)"}]}`,
    parts: [{ text: `NOTE:\n${noteText}\n\nDRAFT:\n${post}` }],
    json: true,
    maxTokens: 12000
  });
  if (truncated) return { post, changes: [] };
  try {
    const r = parseJson(text);
    if (typeof r.post !== 'string' || !r.post.trim()) return { post, changes: [] };
    return { post: r.post.trim(), changes: Array.isArray(r.changes) ? r.changes : [] };
  } catch {
    return { post, changes: [] };
  }
}

async function draftNote(noteId, { feedback = '', trigger = 'manual' } = {}) {
  const data = await store.load();
  const note = data.notes.find(n => n.id === noteId);
  if (!note) throw new Error('Note not found.');
  const previous = data.drafts.filter(d => d.noteId === noteId).at(-1);

  const voice = loadVoiceGuide();
  const t = note.triage || {};
  const brief = [
    `MEERA'S NOTE (received ${note.receivedAt.slice(0, 10)}):`,
    note.text,
    '',
    t.angle ? `Editorial angle: ${t.angle}` : '',
    t.hook ? `Suggested opening mechanism: ${t.hook}` : '',
    t.newsSearch ? `What to search for: ${t.newsSearch}` : '',
    t.needsFromMeera?.length ? `Data only Meera has (use placeholders): ${t.needsFromMeera.join('; ')}` : '',
    previous && feedback ? `\nPREVIOUS DRAFT:\n${previous.post}\n\nMEERA'S FEEDBACK ON IT - apply this:\n${feedback}` : ''
  ].filter(Boolean).join('\n');

  // Thinking tokens count against the output budget, so it is generous - and
  // a cut-off draft is retried with more room rather than saved half-written.
  const call = (maxTokens, extra = '') => generate({ system: DRAFT_SYSTEM(voice), parts: [{ text: brief + extra }], search: true, maxTokens });
  let result = await call(16000);
  if (result.truncated) result = await call(32000);
  // The model sometimes skips the search and describes an angle from memory.
  // An angle with no real source behind it gets one retry that insists on searching.
  if (!result.truncated && !result.sources.length) {
    const retry = await call(16000, '\n\nYou must run Google Search before writing. Cite only an item you actually found in the search results.');
    if (!retry.truncated && retry.sources.length) result = retry;
  }
  if (result.truncated) throw new Error('The draft was cut off twice. Try again.');
  const sections = parseSections(result.text);
  if (!sections.post) throw new Error('The model returned no post text. Try again.');

  let post = sections.post;
  let revised = false;
  const invented = await checkInventions(post, note.text);
  post = invented.post;
  let issues = lint(post);
  if (issues.some(i => i.severity === 'error')) {
    post = await revise(post, issues, voice);
    issues = lint(post);
    revised = true;
  }
  issues.push(...invented.changes.map(c => ({ severity: 'fill', rule: 'Invented detail removed', detail: `"${c.removed}" -> ${c.placeholder}` })));

  const draft = {
    id: store.newId('draft'),
    noteId,
    trigger,
    feedback: feedback || null,
    angle: sections.angle,
    sources: dedupe(result.sources),
    forMeera: sections.forMeera,
    post,
    originalPost: post,
    lint: issues,
    autoRevised: revised,
    status: 'ready',
    createdAt: new Date().toISOString()
  };

  await store.update(d => {
    d.drafts.push(draft);
    const n = d.notes.find(x => x.id === noteId);
    if (n) n.status = 'drafted';
  });
  return draft;
}

function dedupe(sources) {
  const seen = new Set();
  return sources.filter(s => (seen.has(s.url) ? false : seen.add(s.url)));
}

// ---------------------------------------------------------------- cadence

// Vercel runs in UTC, so every day/hour/week decision is made in Meera's
// timezone rather than the server's.
const TIMEZONE = () => process.env.TIMEZONE || 'Asia/Kolkata';

function localParts(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE(), year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short', hour: '2-digit', hourCycle: 'h23'
  }).formatToParts(date).map(p => [p.type, p.value]));
  const dayKey = `${parts.year}-${parts.month}-${parts.day}`;
  // Monday of this local week, as YYYY-MM-DD.
  const d = new Date(`${dayKey}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return { weekday: parts.weekday, hour: Number(parts.hour), dayKey, weekKey: d.toISOString().slice(0, 10) };
}

async function cadence(data) {
  data = data || await store.load();
  const days = (process.env.DRAFT_DAYS || 'Mon,Wed,Fri').split(',').map(s => s.trim().slice(0, 3));
  const hour = Number(process.env.DRAFT_HOUR ?? 8);
  const target = Number(process.env.WEEKLY_TARGET || 3);
  const { weekKey } = localParts();
  const thisWeek = data.drafts.filter(d => localParts(new Date(d.createdAt)).weekKey === weekKey && d.status !== 'rejected' && !d.feedback);
  return { days, hour, target, timezone: TIMEZONE(), thisWeek: thisWeek.length, approvedThisWeek: thisWeek.filter(d => d.status === 'approved').length };
}

// Best note to draft next: a "develop" verdict, highest score, most recent.
function nextCandidate(data) {
  return data.notes
    .filter(n => n.status === 'triaged' && n.triage?.verdict === 'develop')
    .sort((a, b) => b.triage.score - a.triage.score || b.receivedAt.localeCompare(a.receivedAt))[0];
}

// One scheduler step: sort any unsorted notes, then - on a draft day, past
// the draft hour, under the weekly target, not already drafted today - draft
// the best note and ping Meera. On Vercel this is the daily cron; locally it
// runs every 15 minutes. `force` (the "run now" button) skips the day/hour
// and once-a-day checks but still respects the weekly target.
async function tick({ force = false, log = console.log } = {}) {
  try {
    const triaged = await triagePending();
    if (triaged.length) log(`Triage: ${triaged.map(n => `${n.id}=${n.triage.verdict}`).join(', ')}`);
  } catch (err) {
    log(`Triage failed: ${err.message}`);
  }

  const data = await store.load();
  const now = localParts();
  const { days, hour, target, thisWeek } = await cadence(data);
  if (thisWeek >= target) return { message: `Weekly target met (${thisWeek}/${target}). Nothing drafted.` };
  if (!force && (!days.includes(now.weekday) || now.hour < hour)) return { message: 'Not a draft slot yet.' };

  const handledToday = (data.scheduleLog || {})[now.dayKey];
  if (!force && handledToday) return { message: `Already handled today (${handledToday}).` };
  const markToday = outcome => store.update(d => { d.scheduleLog = { ...(d.scheduleLog || {}), [now.dayKey]: outcome }; });

  const note = nextCandidate(data);
  const url = (process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3300}`).replace(/\/$/, '');
  if (!note) {
    const message = `No note in the queue is strong enough for a post today (${thisWeek}/${target} this week). Nothing to do - or drop a note and I'll pick it up.`;
    await markToday('nothing to draft');
    await telegram.sendMessage(message).catch(() => {});
    return { message };
  }
  try {
    const draft = await draftNote(note.id, { trigger: 'schedule' });
    await markToday(`drafted ${draft.id}`);
    log(`Scheduled draft ${draft.id} from ${note.id}`);
    const firstLine = draft.post.split('\n')[0].slice(0, 140);
    await telegram.sendMessage(`Draft ${thisWeek + 1}/${target} this week is ready for you to look at:\n\n"${firstLine}..."\n\n${url}/#${draft.id}`).catch(() => {});
    return { message: 'Draft ready under "To review".' };
  } catch (err) {
    await markToday(`failed: ${err.message}`);
    log(`Scheduled draft failed: ${err.message}`);
    return { message: `Draft failed: ${err.message}` };
  }
}

module.exports = { localParts, receive, ingest, triagePending, draftNote, checkInventions, tick, cadence, lint, loadVoiceGuide, parseSections };
