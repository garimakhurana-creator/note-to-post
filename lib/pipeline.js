const fs = require('fs');
const path = require('path');
const { generate, parseJson } = require('./gemini');
const { lint } = require('./voice-lint');

// Stateless: every function takes what it needs and returns a result.
// Nothing is stored - Telegram messages carry the state (see lib/bot.js).

// The voice guide ships with the app so the drafter follows whatever version
// is checked in.
function loadVoiceGuide() {
  const p = process.env.VOICE_GUIDE_PATH || path.join(__dirname, '..', 'voice-guide.txt');
  return fs.readFileSync(p, 'utf-8');
}

const today = () => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------- transcribe

async function transcribe(audio) {
  const { text } = await generate({
    system: 'Transcribe this voice note verbatim in English. Output only the transcript, no commentary.',
    parts: [{ inlineData: { mimeType: audio.mimeType, data: audio.base64 } }],
    maxTokens: 8000
  });
  if (!text) throw new Error('The transcript came back empty.');
  return text;
}

// ---------------------------------------------------------------- triage

// With no weekly queue to pick the best note from, the filter is the only
// thing that keeps her at roughly three posts a week - so it is strict.
const MIN_SCORE = () => Number(process.env.MIN_SCORE || 7);

const TRIAGE_SYSTEM = voice => `You are the editorial filter for Meera Pillai, founder of Skinstinct, an Indian skincare brand. She drops raw notes into Telegram. Each note you mark "develop" is drafted into a LinkedIn post immediately, and she aims for about 3 posts a week - so be selective. Most notes should not become posts.

Judge the note against her voice guide below.

A note is worth DEVELOPING (score 7-10) only when it has at least one of:
- a specific observation, number, test result, customer question or scene she witnessed
- a gap between what a label/marketing claim says and what the chemistry or data shows
- a mistake or unflattering data point from Skinstinct she could publish honestly
- a regulatory, sourcing or manufacturing detail most readers don't know
and it can be written without her personal life (family, health, her own skin, money worries, burnout are off limits - see 2G).

HOLD (score 4-6) when the idea is promising but too thin on its own, or depends on data only Meera has. SKIP (score 1-3) to-dos, reminders, greetings, links with no comment, personal items, pure product promotion, and anything that would need hype or a banned claim to work.

Return JSON only: {"verdict":"develop|hold|skip","score":1-10,"reason":"one short sentence, addressed to Meera","angle":"one sentence: the post's core claim","hook":"which of her 5 opening mechanisms fits","newsSearch":"what current news or industry data point would make this timely (a search brief)","needsFromMeera":["data only she has"]}

=== VOICE GUIDE ===
${voice}`;

async function triage(noteText) {
  const { text } = await generate({
    system: TRIAGE_SYSTEM(loadVoiceGuide()),
    parts: [{ text: `Today is ${today()}. The note:\n\n${noteText}` }],
    json: true,
    maxTokens: 12000
  });
  const r = parseJson(text);
  const score = Number(r.score) || 0;
  let verdict = ['develop', 'hold', 'skip'].includes(r.verdict) ? r.verdict : 'hold';
  if (verdict === 'develop' && score < MIN_SCORE()) verdict = 'hold';
  return {
    verdict,
    score,
    reason: r.reason || '',
    angle: r.angle || '',
    hook: r.hook || '',
    newsSearch: r.newsSearch || '',
    needsFromMeera: Array.isArray(r.needsFromMeera) ? r.needsFromMeera : []
  };
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
// the post against what Meera actually said and turns anything unsupported
// about Skinstinct or Meera into a placeholder.
async function checkInventions(post, sourceText) {
  const { text, truncated } = await generate({
    system: `You fact-check LinkedIn drafts written for Meera Pillai, founder of Skinstinct. The SOURCE is the ONLY source of truth about Skinstinct, Meera and her customers. Be strict.

Go through the draft sentence by sentence. Flag any detail the source does not literally state about:
- when something happened ("on Tuesday", "last week", "this morning")
- what a customer said, saw or did beyond the source ("the expiry was 14 months away", "she checked the label")
- Skinstinct's products, specs, numbers, tests, methods or processes ("our mid-batch sampling", "we test at 40C", "our serum")
- decisions or alternatives Meera considered ("we could have printed 12 months")
General chemistry, industry facts and the cited news item are NOT flagged.

For each flagged detail, replace just those words with a [square-bracket placeholder] naming what Meera must supply, or delete the clause if the sentence reads fine without it. Change nothing else. Keep placeholders already in the draft. Return JSON only: {"post":"the corrected post","changes":[{"removed":"exact words removed","placeholder":"[the placeholder] or (deleted)"}]}`,
    parts: [{ text: `SOURCE:\n${sourceText}\n\nDRAFT:\n${post}` }],
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

function dedupe(sources) {
  const seen = new Set();
  return sources.filter(s => (seen.has(s.url) ? false : seen.add(s.url)));
}

// Drafts a post from a note, or - with `previousPost` + `feedback` - a new
// version of an earlier draft. For a redraft the previous post and her
// feedback are the source of truth, so real numbers she replies with
// ("PAO is 6 months") get written in instead of placeholders.
async function draft({ note = '', triage: t = {}, previousPost = '', feedback = '' }) {
  const voice = loadVoiceGuide();
  const brief = previousPost
    ? [
        'Rewrite this draft of Meera\'s LinkedIn post using her feedback. Keep what she didn\'t ask to change. If her feedback gives real numbers or facts, use them in place of the matching [placeholders].',
        '', 'PREVIOUS DRAFT:', previousPost, '', "MEERA'S FEEDBACK:", feedback
      ].join('\n')
    : [
        "MEERA'S NOTE:", note, '',
        t.angle ? `Editorial angle: ${t.angle}` : '',
        t.hook ? `Suggested opening mechanism: ${t.hook}` : '',
        t.newsSearch ? `What to search for: ${t.newsSearch}` : '',
        t.needsFromMeera?.length ? `Data only Meera has (use placeholders): ${t.needsFromMeera.join('; ')}` : ''
      ].filter(Boolean).join('\n');

  // Thinking tokens count against the output budget, so it is generous - and
  // a cut-off draft is retried with more room rather than sent half-written.
  const call = (maxTokens, extra = '') => generate({ system: DRAFT_SYSTEM(voice), parts: [{ text: brief + extra }], search: true, maxTokens });
  let result = await call(16000);
  if (result.truncated) result = await call(32000);
  // The model sometimes skips the search and describes an angle from memory.
  // An angle with no real source behind it gets one retry that insists on searching.
  if (!result.truncated && !result.sources.length) {
    const retry = await call(16000, '\n\nYou must run Google Search before writing. Cite only an item you actually found in the search results.');
    if (!retry.truncated && retry.sources.length) result = retry;
  }
  if (result.truncated) throw new Error('The draft was cut off twice.');
  const sections = parseSections(result.text);
  if (!sections.post) throw new Error('The model returned no post text.');

  const source = previousPost ? `${previousPost}\n\nMEERA'S FEEDBACK:\n${feedback}` : note;
  const checked = await checkInventions(sections.post, source);
  let post = checked.post;
  let issues = lint(post);
  if (issues.some(i => i.severity === 'error')) {
    post = await revise(post, issues, voice);
    issues = lint(post);
  }

  return {
    post,
    angle: sections.angle,
    sources: dedupe(result.sources),
    forMeera: sections.forMeera,
    lint: issues,
    inventions: checked.changes
  };
}

module.exports = { transcribe, triage, draft, checkInventions, lint, loadVoiceGuide, parseSections };
