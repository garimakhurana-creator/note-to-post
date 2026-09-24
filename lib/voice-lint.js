// Deterministic checks against the hard rules in voice=skill.txt (sections
// 2C, 2F, 3D). The model is told these rules too, but a draft only reaches
// Meera with any slips flagged, so she isn't the one proofreading for them.

const BANNED = [
  'clean beauty', 'clinically tested', 'dermatologist approved', 'skin-loving',
  'chemical-free', 'toxin-free', 'non-toxic', 'miracle', 'holy grail', 'glass skin',
  'glow', 'transform', 'revolutionary', 'game-changing', 'game-changer',
  'luxurious', 'indulgent', 'self-care ritual', 'obsessed', 'must-have', 'limited time',
  "don't miss out", 'journey', 'passion', "we're so excited", "here's the thing"
];

const CTA = ['shop now', 'link in bio', 'use code', 'discount', 'dm me', 'buy now', 'order now', 'sign up today'];

// American spelling -> the British/Indian form she uses.
const SPELLING = {
  color: 'colour', colors: 'colours', behavior: 'behaviour', behaviors: 'behaviours',
  moisturizer: 'moisturiser', moisturizers: 'moisturisers', moisturize: 'moisturise',
  oxidize: 'oxidise', oxidized: 'oxidised', oxidizes: 'oxidises',
  sensitization: 'sensitisation', standardized: 'standardised', standardize: 'standardise',
  categorization: 'categorisation', realize: 'realise', realized: 'realised',
  organize: 'organise', organization: 'organisation', analyze: 'analyse', analyzed: 'analysed',
  center: 'centre', centimeter: 'centimetre', favorite: 'favourite', stabilize: 'stabilise',
  stabilized: 'stabilised', recognize: 'recognise', emphasize: 'emphasise', minimize: 'minimise'
};

// Spans inside double quotes are where she quotes a claim to take it apart,
// so banned words there are allowed.
function stripQuoted(text) {
  return text.replace(/["“][^"”\n]*["”]/g, m => ' '.repeat(m.length));
}

function lint(text) {
  const issues = [];
  const add = (severity, rule, detail) => issues.push({ severity, rule, detail });
  const unquoted = stripQuoted(text);
  const lower = unquoted.toLowerCase();

  const count = re => (text.match(re) || []).length;

  if (count(/[—–]/g)) add('error', 'Em/en dash', `${count(/[—–]/g)} found - she uses a spaced hyphen ( - ).`);
  if (count(/;/g)) add('error', 'Semicolon', `${count(/;/g)} found - zero in her corpus.`);
  if (count(/!/g)) add('error', 'Exclamation mark', `${count(/!/g)} found - zero in her corpus.`);
  if (count(/(^|\s)#[A-Za-z]\w*/g)) add('error', 'Hashtag', 'She never uses hashtags.');
  if (/\p{Extended_Pictographic}/u.test(text)) add('error', 'Emoji', 'She never uses emojis.');

  const questions = count(/\?/g);
  if (questions) add('warn', 'Question mark', `${questions} found - fine only if quoting someone or her own inner question, never as a hook.`);

  const firstPara = text.trim().split(/\n\s*\n/)[0] || '';
  if (firstPara.includes('?')) add('error', 'Question hook', 'Opens with a question - she never uses rhetorical-question hooks.');

  for (const word of BANNED) {
    const re = new RegExp(`\\b${word.replace(/[-']/g, m => '\\' + m)}\\w*`, 'i');
    if (re.test(lower)) add('error', 'Banned word', `"${word}" used as a claim (allowed only inside quotes to take it apart).`);
  }
  for (const phrase of CTA) {
    if (lower.includes(phrase)) add('error', 'Sales CTA', `"${phrase}" - she closes with a question or practical step, never a pitch.`);
  }
  for (const [us, uk] of Object.entries(SPELLING)) {
    if (new RegExp(`\\b${us}\\b`, 'i').test(unquoted)) add('warn', 'Spelling', `"${us}" -> "${uk}".`);
  }
  if (/\b[A-Z]{4,}\b/.test(unquoted.replace(/\b(INCI|SPF|UVA|UVB|CDSCO|BIS|FSSAI|USFDA|FDA|WHO|PAO|NMF|TEWL|AHA|BHA|PHA)\b/g, ''))) {
    add('warn', 'All caps', 'All-caps emphasis - only acceptable when quoting a banner.');
  }

  const paragraphs = text.trim().split(/\n\s*\n/).filter(p => p.trim());
  const sentencesIn = p => (p.match(/[^.!?]+[.!?]+/g) || [p]).length;
  const oneLiners = paragraphs.filter(p => sentencesIn(p) === 1).length;
  if (paragraphs.length >= 5 && oneLiners / paragraphs.length > 0.5) {
    add('warn', 'Broetry', `${oneLiners}/${paragraphs.length} paragraphs are single sentences - hers are 3-7 sentences, with only verdicts standing alone.`);
  }

  const spelled = unquoted.match(/\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty)\s+(days?|weeks?|months?|years?|percent|people|customers|batches)\b/gi) || [];
  if (spelled.length) add('warn', 'Numerals', `Use numerals for measurements: ${spelled.join(', ')}.`);

  if (!/[.)"”'’\]]\s*$/.test(text.trim())) add('error', 'Cut off', 'The post does not end with a finished sentence.');

  const placeholders =text.match(/\[[^\]]+\]/g) || [];
  if (placeholders.length) {
    add('fill', 'Needs Meera\'s data', `${placeholders.length} placeholder(s) to fill with real Skinstinct numbers: ${placeholders.join(', ')}`);
  }

  if (text.length > 3000) add('error', 'Too long', `${text.length} characters - LinkedIn's limit is 3,000.`);

  return issues;
}

module.exports = { lint };
