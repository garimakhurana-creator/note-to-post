// Meera keeps messaging her bot exactly as she messages herself today.
// Deployed, Telegram pushes each message to /api/telegram (a webhook).
// Locally, the app long-polls instead, so no public URL is needed.

const token = () => process.env.TELEGRAM_BOT_TOKEN;
const allowedChat = () => (process.env.TELEGRAM_CHAT_ID || '').trim();

async function call(method, params = {}) {
  const res = await fetch(`https://api.telegram.org/bot${token()}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params)
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.description}`);
  return data.result;
}

async function sendMessage(text, chatId = allowedChat()) {
  if (!token() || !chatId) return;
  await call('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true });
}

async function downloadFile(fileId) {
  const file = await call('getFile', { file_id: fileId });
  const res = await fetch(`https://api.telegram.org/file/bot${token()}/${file.file_path}`);
  if (!res.ok) throw new Error(`Telegram file download failed (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

// Turns one Telegram update into a note payload, or null if it isn't one.
// Voice notes are downloaded here and transcribed later by the pipeline.
async function toNote(update) {
  const msg = update.message || update.channel_post;
  if (!msg) return null;
  const chatId = String(msg.chat.id);
  const text = (msg.text || msg.caption || '').trim();

  if (text === '/start' || text === '/id') {
    console.log(`Telegram: /start from chat ${chatId} (${msg.chat.first_name || msg.chat.title || 'unknown'})`);
    await sendMessage(
      allowedChat()
        ? 'Connected. Send notes here as usual - drafts will show up in your review queue.'
        : `Your chat id is ${chatId}. Put TELEGRAM_CHAT_ID=${chatId} in note-to-post/.env and restart.`,
      chatId
    );
    return null;
  }
  // Ignore everyone except Meera once the chat id is configured. Before
  // that, ignore everything, so a stranger can't seed the queue.
  if (!allowedChat() || chatId !== allowedChat()) return null;
  if (text.startsWith('/')) return null;

  const base = {
    telegramMessageId: msg.message_id,
    receivedAt: new Date(msg.date * 1000).toISOString(),
    forwardedFrom: msg.forward_origin?.sender_user?.first_name || msg.forward_origin?.chat?.title || null
  };

  const voice = msg.voice || msg.audio;
  if (voice) {
    const audio = await downloadFile(voice.file_id);
    return { ...base, kind: 'voice', text: text || '', audio: { mimeType: voice.mime_type || 'audio/ogg', base64: audio.toString('base64') } };
  }
  if (!text) return null;
  return { ...base, kind: 'text', text };
}

// Points the bot at the deployed app. `secret` comes back on every call in
// the X-Telegram-Bot-Api-Secret-Token header, so only Telegram can post notes.
async function setWebhook(url, secret) {
  return call('setWebhook', { url, secret_token: secret, allowed_updates: ['message', 'channel_post'], drop_pending_updates: false });
}

// Starts the polling loop. `onNote` receives each accepted note; `getOffset`
// and `setOffset` persist the update cursor so restarts don't re-import.
function startPolling({ onNote, getOffset, setOffset, log = console.log }) {
  if (!token()) {
    log('Telegram: TELEGRAM_BOT_TOKEN not set - polling disabled. Notes can still be added from the web page.');
    return;
  }
  let stopped = false;
  (async function loop() {
    // Polling and a webhook can't both be active. If the deployed app owns
    // the bot, leave it alone rather than silently breaking production.
    try {
      const info = await call('getWebhookInfo', {});
      if (info.url) {
        log(`Telegram: webhook set to ${info.url} - not polling locally. Notes go to the deployed app.`);
        return;
      }
    } catch (err) {
      log(`Telegram: could not check webhook - ${err.message}`);
    }
    log(`Telegram: polling${allowedChat() ? ` for chat ${allowedChat()}` : ' (no TELEGRAM_CHAT_ID yet - send /start to the bot)'}`);
    while (!stopped) {
      try {
        const updates = await call('getUpdates', { offset: await getOffset(), timeout: 30, allowed_updates: ['message', 'channel_post'] });
        for (const update of updates) {
          try {
            const note = await toNote(update);
            if (note) await onNote(note);
          } catch (err) {
            log(`Telegram: skipped update ${update.update_id} - ${err.message}`);
          }
          await setOffset(update.update_id + 1);
        }
      } catch (err) {
        log(`Telegram: ${err.message} - retrying in 10s`);
        await new Promise(r => setTimeout(r, 10000));
      }
    }
  })();
  return () => { stopped = true; };
}

module.exports = { startPolling, sendMessage, setWebhook, toNote };
