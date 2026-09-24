const telegram = require('./telegram');
const pipeline = require('./pipeline');

// Everything happens in the chat, and nothing is stored: each message the
// bot sends carries what a later reply needs.
//
//   a note (text or voice)             -> sorted; if worth it, drafted with a news angle
//   "draft" as a reply to a note       -> drafted even though the filter said no
//   any reply to a draft               -> a new version using that feedback
//
// The draft itself goes out as a message of its own, with nothing else in it,
// so it copies cleanly into LinkedIn. Every other bot message starts with one
// of these labels, which is how a reply to a draft is told apart from a reply
// to anything else.
const LABEL = {
  worth: 'Worth a post',
  skip: 'Not drafting this one',
  about: 'About this draft',
  redraft: 'New version coming',
  error: 'Something went wrong',
  hint: 'Reply to the draft itself'
};
const isLabelled = text => Object.values(LABEL).some(l => (text || '').startsWith(l)) || /^(Connected|Your chat id)/.test(text || '');

const allowedChat = () => (process.env.TELEGRAM_CHAT_ID || '').trim();
const FORCE = /^\/?draft( it)?( anyway)?\.?$/i;
const quoted = text => text.length > 2500 ? text.slice(0, 2500) + '…' : text;

// Pulls the note back out of a "Not drafting this one" message.
function noteFromSkipMessage(text) {
  const m = (text || '').match(/\nNote: "([\s\S]*)"\n\nReply "draft"/);
  return m ? m[1] : null;
}

async function noteText(msg) {
  const text = (msg.text || msg.caption || '').trim();
  const voice = msg.voice || msg.audio;
  if (!voice) return { text, voice: false };
  const audio = await telegram.downloadFile(voice.file_id);
  const transcript = await pipeline.transcribe({ mimeType: voice.mime_type || 'audio/ogg', base64: audio.toString('base64') });
  return { text: [text, transcript].filter(Boolean).join('\n\n'), voice: true };
}

function aboutMessage(d) {
  const lines = [`${LABEL.about}`, 'Check it, fill anything in brackets, then copy the message above into LinkedIn.', ''];

  lines.push(`News angle: ${d.angle || 'none given.'}`);
  if (d.sources.length) d.sources.slice(0, 3).forEach(s => lines.push(`Source: ${s.title} - ${s.url}`));
  else lines.push('No live search source came back - check the news angle before posting.');

  const fills = (d.post.match(/\[[^\]]+\]/g) || []);
  if (fills.length) lines.push('', `Fill in before posting: ${fills.join(', ')}`);
  if (d.inventions.length) {
    lines.push('', 'Made-up details I took out:');
    d.inventions.forEach(c => lines.push(`- "${c.removed}" -> ${c.placeholder}`));
  }

  const problems = d.lint.filter(i => i.severity !== 'fill');
  lines.push('', problems.length
    ? `Voice check:\n${problems.map(i => `- ${i.rule}: ${i.detail}`).join('\n')}`
    : 'Voice check: passes.');

  if (d.forMeera) lines.push('', `Drafter's notes:\n${d.forMeera}`);
  lines.push('', 'To change it, reply to the draft with what to change - or with the real numbers for the brackets.');
  return lines.join('\n');
}

async function sendDraft(chatId, d, replyTo) {
  const postMsg = await telegram.sendMessage(chatId, d.post, { replyTo });
  await telegram.sendMessage(chatId, aboutMessage(d), { replyTo: postMsg.message_id });
}

async function handleNote(chatId, msgId, note, { force = false, voice = false } = {}) {
  const heard = voice ? `\n\nHeard: "${quoted(note)}"` : '';
  const t = await pipeline.triage(note);
  if (!force && t.verdict !== 'develop') {
    await telegram.sendMessage(chatId,
      `${LABEL.skip} (${t.verdict}, ${t.score}/10): ${t.reason}\n\nNote: "${quoted(note)}"\n\nReply "draft" to this message to draft it anyway.`,
      { replyTo: msgId });
    return;
  }
  await telegram.sendMessage(chatId,
    `${LABEL.worth} (${t.score}/10): ${t.reason}\nDrafting now with a current news angle - about 2 minutes.${heard}`,
    { replyTo: msgId });
  await telegram.typing(chatId);
  await sendDraft(chatId, await pipeline.draft({ note, triage: t }), msgId);
}

async function handleRedraft(chatId, msgId, previousPost, feedback) {
  await telegram.sendMessage(chatId, `${LABEL.redraft} - about 2 minutes.`, { replyTo: msgId });
  await telegram.typing(chatId);
  await sendDraft(chatId, await pipeline.draft({ previousPost, feedback }), msgId);
}

async function route(msg) {
  const chatId = String(msg.chat.id);
  const text = (msg.text || msg.caption || '').trim();

  if (text === '/start' || text === '/id') {
    console.log(`Telegram: /start from chat ${chatId} (${msg.chat.first_name || msg.chat.title || 'unknown'})`);
    return telegram.sendMessage(chatId, allowedChat() === chatId
      ? 'Connected. Send notes here as usual - text or voice. The ones worth a post come back as a LinkedIn draft.'
      : `Your chat id is ${chatId}. Set TELEGRAM_CHAT_ID=${chatId} in the Vercel project to connect this chat.`);
  }
  // Only Meera's chat. Before TELEGRAM_CHAT_ID is set, nobody's notes are used.
  if (!allowedChat() || chatId !== allowedChat()) return;
  if (text.startsWith('/') && !FORCE.test(text)) return;

  const reply = msg.reply_to_message;
  if (reply?.from?.is_bot) {
    if (!isLabelled(reply.text)) {
      if (!text) return telegram.sendMessage(chatId, 'Type what to change as a text reply to the draft.', { replyTo: msg.message_id });
      return handleRedraft(chatId, msg.message_id, reply.text, text);
    }
    const skipped = noteFromSkipMessage(reply.text);
    if (skipped && FORCE.test(text)) return handleNote(chatId, msg.message_id, skipped, { force: true });
    if (reply.text.startsWith(LABEL.about)) {
      return telegram.sendMessage(chatId, `${LABEL.hint} (the message above this one) so I can see which version you mean.`, { replyTo: msg.message_id });
    }
  }
  if (reply && !reply.from?.is_bot && FORCE.test(text)) {
    const n = await noteText(reply);
    if (n.text) return handleNote(chatId, reply.message_id, n.text, { force: true, voice: n.voice });
  }

  const n = await noteText(msg);
  if (n.text) return handleNote(chatId, msg.message_id, n.text, { voice: n.voice });
}

// Entry point for one Telegram update. Failures are reported in the chat so
// a note never disappears silently.
async function handleUpdate(update) {
  const msg = update.message;
  if (!msg?.chat) return;
  try {
    await route(msg);
  } catch (err) {
    console.error(`Update ${update.update_id}: ${err.message}`);
    if (String(msg.chat.id) === allowedChat()) {
      await telegram.sendMessage(msg.chat.id,
        `${LABEL.error}: ${err.message}\nReply "draft" to your note to try again.`,
        { replyTo: msg.message_id }).catch(() => {});
    }
  }
}

module.exports = { handleUpdate, aboutMessage, noteFromSkipMessage, isLabelled };
