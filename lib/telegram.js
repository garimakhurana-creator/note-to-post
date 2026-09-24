// Thin wrapper over the Telegram Bot API. Deployed, Telegram pushes each
// message to /api/telegram (a webhook). Locally, the app long-polls instead.

const token = () => process.env.TELEGRAM_BOT_TOKEN;
const LIMIT = 4096; // Telegram's max message length

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

// Plain text on purpose (no Markdown), so a draft copies into LinkedIn
// exactly as written.
function sendMessage(chatId, text, { replyTo } = {}) {
  const body = text.length > LIMIT ? text.slice(0, LIMIT - 1) + '…' : text;
  return call('sendMessage', {
    chat_id: chatId,
    text: body,
    link_preview_options: { is_disabled: true },
    ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {})
  });
}

const typing = chatId => call('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});

async function downloadFile(fileId) {
  const file = await call('getFile', { file_id: fileId });
  const res = await fetch(`https://api.telegram.org/file/bot${token()}/${file.file_path}`);
  if (!res.ok) throw new Error(`Telegram file download failed (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

// `secret` comes back on every call in the X-Telegram-Bot-Api-Secret-Token
// header, so only Telegram can post to the webhook.
function setWebhook(url, secret) {
  return call('setWebhook', { url, secret_token: secret, allowed_updates: ['message'] });
}

// Local development only. Refuses to run while a webhook is set, so a laptop
// never steals messages from the deployed bot.
async function startPolling(onUpdate, log = console.log) {
  if (!token()) return log('Telegram: TELEGRAM_BOT_TOKEN not set.');
  const info = await call('getWebhookInfo');
  if (info.url) return log(`Telegram: webhook set to ${info.url} - not polling. The deployed bot is handling messages.`);
  log('Telegram: polling for messages');
  let offset = 0;
  for (;;) {
    try {
      const updates = await call('getUpdates', { offset, timeout: 30, allowed_updates: ['message'] });
      for (const update of updates) {
        offset = update.update_id + 1;
        await onUpdate(update).catch(err => log(`Update ${update.update_id} failed: ${err.message}`));
      }
    } catch (err) {
      log(`Telegram: ${err.message} - retrying in 10s`);
      await new Promise(r => setTimeout(r, 10000));
    }
  }
}

module.exports = { call, sendMessage, typing, downloadFile, setWebhook, startPolling };
