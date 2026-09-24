const test = require('node:test');
const assert = require('node:assert');
const { aboutMessage, noteFromSkipMessage, isLabelled } = require('../lib/bot');

test('a skipped note can be recovered from the bot message', () => {
  const msg = 'Not drafting this one (hold, 5/10): too thin.\n\nNote: "banner said "dermatologist approved""\n\nReply "draft" to this message to draft it anyway.';
  assert.strictEqual(noteFromSkipMessage(msg), 'banner said "dermatologist approved"');
});

test('drafts are unlabelled, every other bot message is labelled', () => {
  assert.ok(!isLabelled('Last month a customer emailed to ask why...'));
  for (const t of ['Worth a post (8/10): x', 'Not drafting this one (skip, 1/10): x', 'About this draft\n...', 'New version coming', 'Something went wrong: x', 'Connected. Send notes']) {
    assert.ok(isLabelled(t), t);
  }
});

test('about message lists sources, placeholders and removed inventions', () => {
  const text = aboutMessage({
    post: 'For [product], the PAO is [months].', angle: 'CDSCO notice, Sept 2026.',
    sources: [{ title: 'cdsco.gov.in', url: 'https://example.org' }], forMeera: '- check the date',
    lint: [{ severity: 'fill', rule: 'x', detail: 'y' }], inventions: [{ removed: 'on Tuesday', placeholder: '(deleted)' }]
  });
  assert.ok(text.startsWith('About this draft'));
  assert.ok(text.includes('Source: cdsco.gov.in - https://example.org'));
  assert.ok(text.includes('[product], [months]'));
  assert.ok(text.includes('"on Tuesday" -> (deleted)'));
  assert.ok(text.includes('Voice check: passes.'));
});
