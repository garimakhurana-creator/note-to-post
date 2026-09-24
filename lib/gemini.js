const MODEL = () => process.env.GEMINI_MODEL || 'gemini-3.1-pro-preview';

function apiKey() {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!key || !key.trim()) {
    throw new Error('GEMINI_API_KEY is not set. Add it to note-to-post/.env and restart.');
  }
  return key;
}

// One call to generateContent. `search: true` turns on Google Search
// grounding, whose real result URLs come back in groundingMetadata - those,
// not whatever URLs the model writes in its text, are what we cite.
async function generate({ system, parts, search = false, json = false, maxTokens = 4000 }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL())}:generateContent?key=${encodeURIComponent(apiKey())}`;
  const body = {
    contents: [{ role: 'user', parts }],
    systemInstruction: { parts: [{ text: system }] },
    generationConfig: { maxOutputTokens: maxTokens }
  };
  if (search) body.tools = [{ google_search: {} }];
  if (json) body.generationConfig.responseMimeType = 'application/json';

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || `Gemini request failed (${response.status})`);

  const candidate = (data.candidates || [])[0];
  const text = (candidate?.content?.parts || [])
    .filter(p => typeof p.text === 'string')
    .map(p => p.text)
    .join('\n')
    .trim();

  const sources = (candidate?.groundingMetadata?.groundingChunks || [])
    .map(c => c.web)
    .filter(w => w && w.uri)
    .map(w => ({ title: w.title || w.uri, url: w.uri }));

  return { text, sources, truncated: candidate?.finishReason === 'MAX_TOKENS' };
}

function parseJson(text) {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  return JSON.parse(cleaned);
}

module.exports = { generate, parseJson };
