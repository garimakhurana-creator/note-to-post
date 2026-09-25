const fs = require('fs');
const path = require('path');
const { generate, parseJson, FAST_MODEL } = require('./gemini');
const { searchNews } = require('./news');
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

// Score 0-10. Notes at MIN_SCORE (default 6) or above are drafted, below it
// Meera gets a one-line reason instead. Runs on Gemini Flash.
const MIN_SCORE = () => Number(process.env.MIN_SCORE || 6);

const TRIAGE_SYSTEM = voice => `You are the editorial filter for Meera Pillai, founder of Skinstinct, an Indian skincare brand. She drops raw notes into Telegram. Score how publishable each note is as a LinkedIn post in her voice. Notes scoring 6 or more are drafted immediately, and she aims for about 3 posts a week - so be selective. Most notes should not become posts.

Judge the note against her voice guide below.

6-10: a note with a clear point and enough substance to write from - at least one of: a specific observation, number, test result, customer question or scene she witnessed; a gap between what a label or marketing claim says and what the chemistry or data shows; a mistake or unflattering Skinstinct data point she could publish honestly; a regulatory, sourcing or manufacturing detail most readers don't know. It must be writable without her personal life (family, health, her own skin, money worries, burnout are off limits - see 2G).
4-5: promising but too thin on its own, or depends on data only Meera has.
0-3: task reminders, logistics, greetings, abandoned half-sentences, links with no comment, personal items, pure product promotion, anything that would need hype or a banned claim.

Return JSON only: {"score":0-10,"reason":"one short sentence, addressed to Meera","angle":"one sentence: the post's core claim","hook":"which of her 5 opening mechanisms fits","needsFromMeera":["data only she has"]}

=== VOICE GUIDE ===
${voice}`;

async function triage(noteText) {
  const { text } = await generate({
    system: TRIAGE_SYSTEM(loadVoiceGuide()),
    parts: [{ text: `Today is ${today()}. The note:\n\n${noteText}` }],
    json: true,
    model: FAST_MODEL(),
    maxTokens: 8000
  });
  const r = parseJson(text);
  const score = Math.max(0, Math.min(10, Number(r.score) || 0));
  return {
    score,
    passed: score >= MIN_SCORE(),
    verdict: score >= MIN_SCORE() ? 'develop' : score >= 4 ? 'hold' : 'skip',
    reason: r.reason || '',
    angle: r.angle || '',
    hook: r.hook || '',
    needsFromMeera: Array.isArray(r.needsFromMeera) ? r.needsFromMeera : []
  };
}

// ---------------------------------------------------------------- news angle

// Gemini Flash turns the note into 3-5 search terms and a short phrase;
// Google News supplies recent results for it.
async function findNews(noteText) {
  const { text } = await generate({
    system: 'Extract 3-5 search terms from this skincare founder\'s note that would find a relevant recent news story, regulatory update or industry data point. Use words a news headline would use (e.g. "cosmetics labelling", "sunscreen SPF", "CDSCO"), most important first. Return JSON only: {"terms":["..."],"phrase":"a short news search phrase of 2-4 words"}',
    parts: [{ text: noteText }],
    json: true,
    model: FAST_MODEL(),
    maxTokens: 4000
  });
  const r = parseJson(text);
  const terms = Array.isArray(r.terms) ? r.terms.filter(Boolean) : [];
  // Notes are specific, news is broad: widen step by step until something comes back.
  const attempts = [...new Set([
    (r.phrase || terms.slice(0, 3).join(' ')).trim(),
    terms.slice(0, 2).join(' '),
    terms[0] ? `${terms[0]} skincare` : '',
    terms[0] ? `${terms[0]} India` : ''
  ].filter(Boolean))];
  for (const phrase of attempts) {
    const items = await searchNews(phrase).catch(() => []);
    if (items.length) return { phrase, terms, items };
  }
  return { phrase: attempts[0] || '', terms, items: [] };
}

// The verify flag required at the end of any draft that uses a news item.
// It stays on the draft Meera receives: she checks the claim, then deletes
// the block before posting.
const RULE = '\u2500'.repeat(33);
function verifyFlag(n) {
  return [
    RULE,
    `NEWS SOURCE: ${n.headline}`,
    `FROM: ${n.source} \u00b7 ${n.date}`,
    `LINK: ${n.link}`,
    '\u26a0 Check this before publishing \u2014 you are the author of this claim',
    RULE
  ].join('\n');
}

function splitVerifyFlag(post) {
  const m = post.match(/\n*\u2500+\nNEWS SOURCE: (.*)\nFROM: (.*) \u00b7 (.*)\nLINK: (.*)\n\u26a0[^\n]*\n\u2500+\s*$/);
  if (!m) return { body: post.trim(), news: null };
  return { body: post.slice(0, m.index).trim(), news: { headline: m[1], source: m[2], date: m[3], link: m[4], summary: '' } };
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

NEWS: you may be given recent news items found for this note. If this news item is genuinely relevant, use it to make the post timely. If it doesn't fit naturally, ignore it. When you use one, reference it the way she would - specifically, with who published it and when - without claiming more than the headline supports. Never mention any other source.

Output exactly these three sections and nothing else:
===NEWS_USED===
The number of the news item you used, or "none".
===POST===
The post text only. Do not add a source line - one is added for you.
===FOR_MEERA===
Short bullet list: what she should verify, which placeholders need her numbers, and anything in the note you chose to leave out and why.

=== VOICE GUIDE ===
${voice}`;

function parseSections(text) {
  const grab = name => {
    const m = text.match(new RegExp(`===${name}===\\s*([\\s\\S]*?)(?====[A-Z_]+===|$)`));
    return m ? m[1].trim() : '';
  };
  return { newsUsed: grab('NEWS_USED'), post: grab('POST'), forMeera: grab('FOR_MEERA') };
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

function newsBlock(items) {
  if (!items.length) return 'NEWS ITEMS: none found.';
  return 'NEWS ITEMS:\n' + items.map((n, i) => `${i + 1}. "${n.headline}" - ${n.source}, ${n.date}${n.summary ? `. ${n.summary}` : ''}`).join('\n');
}

// Drafts a post from a note, or - with `previousPost` + `feedback` - a new
// version of an earlier draft. For a redraft the previous post and her
// feedback are the source of truth, so real numbers she replies with
// ("PAO is 6 months") get written in instead of placeholders, and the news
// item is recovered from the previous draft's verify flag.
async function draft({ note = '', triage: t = {}, previousPost = '', feedback = '' }) {
  const voice = loadVoiceGuide();
  const previous = previousPost ? splitVerifyFlag(previousPost) : null;
  const news = previous
    ? { phrase: '', items: previous.news ? [previous.news] : [] }
    : await findNews(note).catch(() => ({ phrase: '', items: [] }));

  const brief = (previous
    ? [
        "Rewrite this draft of Meera's LinkedIn post using her feedback. Keep what she didn't ask to change. If her feedback gives real numbers or facts, use them in place of the matching [placeholders].",
        '', 'PREVIOUS DRAFT:', previous.body, '', "MEERA'S FEEDBACK:", feedback
      ]
    : [
        "MEERA'S NOTE:", note, '',
        t.angle ? `Editorial angle: ${t.angle}` : '',
        t.hook ? `Suggested opening mechanism: ${t.hook}` : '',
        t.needsFromMeera?.length ? `Data only Meera has (use placeholders): ${t.needsFromMeera.join('; ')}` : ''
      ]
  ).concat(['', newsBlock(news.items)]).join('\n');

  // Thinking tokens count against the output budget, so it is generous - and
  // a cut-off draft is retried with more room rather than sent half-written.
  const call = maxTokens => generate({ system: DRAFT_SYSTEM(voice), parts: [{ text: brief }], maxTokens });
  let result = await call(16000);
  if (result.truncated) result = await call(32000);
  if (result.truncated) throw new Error('The draft was cut off twice.');
  const sections = parseSections(result.text);
  if (!sections.post) throw new Error('The model returned no post text.');

  const usedIndex = parseInt(sections.newsUsed, 10);
  const used = Number.isInteger(usedIndex) ? news.items[usedIndex - 1] || null : null;

  const source = previous ? `${previous.body}\n\nMEERA'S FEEDBACK:\n${feedback}` : note;
  const checked = await checkInventions(sections.post, source);
  let body = checked.post;
  let issues = lint(body);
  if (issues.some(i => i.severity === 'error')) {
    body = await revise(body, issues, voice);
    issues = lint(body);
  }

  return {
    post: used ? `${body}\n\n${verifyFlag(used)}` : body,
    body,
    news: used,
    newsPhrase: news.phrase,
    newsCandidates: news.items,
    forMeera: sections.forMeera,
    lint: issues,
    inventions: checked.changes
  };
}

module.exports = { transcribe, triage, findNews, draft, checkInventions, lint, loadVoiceGuide, parseSections, verifyFlag, splitVerifyFlag };
