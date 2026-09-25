const test = require('node:test');
const assert = require('node:assert');
const { lint } = require('../lib/voice-lint');
const { parseSections } = require('../lib/pipeline');

const rules = text => lint(text).map(i => i.rule);

test('clean text in her voice passes', () => {
  const text = 'Most serums don\'t list their pH on the label. This is legal. It is also not helpful.\n\nIf a brand can\'t tell you the pH, that\'s useful information.';
  assert.deepStrictEqual(lint(text), []);
});

test('flags punctuation she never uses', () => {
  const r = rules('This is huge! It works — mostly; trust me. #skincare ✨');
  for (const rule of ['Exclamation mark', 'Em/en dash', 'Semicolon', 'Hashtag', 'Emoji']) assert.ok(r.includes(rule), rule);
});

test('banned words allowed only inside quotes', () => {
  assert.ok(rules('Our serum gives you a real glow.').includes('Banned word'));
  assert.ok(!rules('The label says "clean beauty". That is a marketing category, not a scientific one.').includes('Banned word'));
});

test('question hook, CTA, American spelling, placeholders', () => {
  const r = rules('Ever wondered why your serum turns orange?\n\nThe color changes. Shop now.\n\nOur returns were [returns % from humid cities].');
  for (const rule of ['Question hook', 'Sales CTA', 'Spelling', "Needs Meera's data"]) assert.ok(r.includes(rule), rule);
});

test('parses the three draft sections', () => {
  const s = parseSections('===NEWS_USED===\n2\n===POST===\nLine one.\n\nLine two.\n===FOR_MEERA===\n- fill the pH');
  assert.strictEqual(s.newsUsed, '2');
  assert.strictEqual(s.post, 'Line one.\n\nLine two.');
  assert.strictEqual(s.forMeera, '- fill the pH');
});

test('flags spelled-out numbers and cut-off endings', () => {
  const r = rules('It turned orange after six weeks. The expiry date and the PAO');
  assert.ok(r.includes('Numerals'));
  assert.ok(r.includes('Cut off'));
});

test('verify flag survives a round trip, so a redraft keeps its news item', () => {
  const { verifyFlag, splitVerifyFlag } = require('../lib/pipeline');
  const news = { headline: 'H', source: 'S', date: '2026-09-20', link: 'https://x.y/z' };
  const flag = verifyFlag(news);
  assert.ok(flag.includes('NEWS SOURCE: H') && flag.includes('FROM: S · 2026-09-20') && flag.includes('LINK: https://x.y/z'));
  assert.ok(flag.includes('⚠ Check this before publishing — you are the author of this claim'));
  const back = splitVerifyFlag(`Body.\n\n${flag}`);
  assert.strictEqual(back.body, 'Body.');
  assert.strictEqual(back.news.link, 'https://x.y/z');
});

test('Google News RSS items parse into headline, source, date, link', () => {
  const { parseRss } = require('../lib/news');
  const xml = '<rss><channel><item><title>CDSCO tightens labels - The Hindu</title><link>https://news.google.com/a</link><pubDate>Sun, 20 Sep 2026 08:00:00 GMT</pubDate><description>&lt;a href="x"&gt;CDSCO tightens labels&lt;/a&gt;</description><source url="https://thehindu.com">The Hindu</source></item></channel></rss>';
  assert.deepStrictEqual(parseRss(xml)[0], { headline: 'CDSCO tightens labels', source: 'The Hindu', date: '2026-09-20', link: 'https://news.google.com/a', summary: '' });
});
