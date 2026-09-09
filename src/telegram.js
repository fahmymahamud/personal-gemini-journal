// One place that knows how to talk to the Bot API. The /send route, the
// reminder scheduler and the webhook all go through here, so a change to how we
// call Telegram cannot drift between them.

export const MAX_MESSAGE_CHARS = 4096;
export const MAX_CAPTION_CHARS = 1024;   // Telegram caps captions lower than text

export function botToken() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    const err = new Error('Telegram is not configured on the server — TELEGRAM_BOT_TOKEN is missing.');
    err.status = 503;
    err.expose = true;   // names the fix; the coach cannot do anything else about it
    throw err;
  }
  return token;
}

/**
 * Every Bot API call funnels through here and resolves an outcome rather than
 * throwing. The scheduler sends in bulk and the webhook must answer 200 no
 * matter what, so a blocked chat has to be a value, not an exception. Callers
 * that want an error (the /send route) raise one from the returned shape.
 */
async function call(method, payload) {
  let response;
  let data = {};
  try {
    response = await fetch(`https://api.telegram.org/bot${botToken()}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    data = await response.json().catch(() => ({}));
  } catch (cause) {
    return { ok: false, result: null, description: cause.message, status: 0 };
  }

  if (!response.ok || !data.ok) {
    // Telegram's own wording is the useful part ("chat not found", "bot was
    // blocked by the user"), so it is passed back rather than flattened.
    return {
      ok: false,
      result: null,
      description: data.description || `HTTP ${response.status}`,
      status: response.status,
    };
  }
  return { ok: true, result: data.result, description: null, status: 200 };
}

export async function sendTelegramMessage(chatId, message, { replyMarkup = null } = {}) {
  const text = String(message || '').trim().slice(0, MAX_MESSAGE_CHARS);
  if (!text) return { ok: false, messageId: null, description: 'Message cannot be empty', status: 400 };

  const out = await call('sendMessage', {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
  return { ...out, messageId: out.result?.message_id ?? null };
}

/** `photo` is a Telegram file_id — re-sending one costs no upload. */
export async function sendTelegramPhoto(chatId, photo, { caption = '', replyMarkup = null } = {}) {
  const out = await call('sendPhoto', {
    chat_id: chatId,
    photo,
    ...(caption ? { caption: String(caption).slice(0, MAX_CAPTION_CHARS) } : {}),
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
  return { ...out, messageId: out.result?.message_id ?? null };
}

/**
 * Answers the button tap. Telegram shows a spinner on the button until this
 * lands, so it is sent before any slower work (Firestore writes, uploads).
 */
export function answerCallback(callbackQueryId, text = '', { alert = false } = {}) {
  return call('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text: String(text).slice(0, 200),
    show_alert: alert,
  });
}

/**
 * Rewrites the message the buttons were attached to. Passing no reply_markup
 * drops the keyboard, which is what stops a parent tapping "I've paid" five
 * times and filing five declarations.
 */
export function editMessageText(chatId, messageId, text) {
  return call('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text: String(text).slice(0, MAX_MESSAGE_CHARS),
    disable_web_page_preview: true,
  });
}

/** Same, for a photo message — a caption cannot be edited with editMessageText. */
export function editMessageCaption(chatId, messageId, caption) {
  return call('editMessageCaption', {
    chat_id: chatId,
    message_id: messageId,
    caption: String(caption).slice(0, MAX_CAPTION_CHARS),
  });
}

/** Two-step download: getFile yields a path, then the file server serves it. */
export async function fetchTelegramFile(fileId) {
  const meta = await call('getFile', { file_id: fileId });
  if (!meta.ok) return { ok: false, buffer: null, description: meta.description };

  const path = meta.result?.file_path;
  if (!path) return { ok: false, buffer: null, description: 'Telegram returned no file path' };

  try {
    const res = await fetch(`https://api.telegram.org/file/bot${botToken()}/${path}`);
    if (!res.ok) return { ok: false, buffer: null, description: `File download failed (${res.status})` };
    return {
      ok: true,
      buffer: Buffer.from(await res.arrayBuffer()),
      path,
      description: null,
    };
  } catch (cause) {
    return { ok: false, buffer: null, description: cause.message };
  }
}

/* ═══════════════════ keyboards ═══════════════════ */

// callback_data is capped at 64 bytes by Telegram, and a Firestore id is 20,
// so "action:id" fits with room to spare.
export const payerButtons = (studentId) => ({
  inline_keyboard: [
    [
      { text: "✅ I've Paid", callback_data: `paid:${studentId}` },
      { text: '📸 Send Receipt', callback_data: `receipt:${studentId}` },
    ],
    [{ text: '⏰ Remind Me Later', callback_data: `later:${studentId}` }],
  ],
});

export const coachButtons = (studentId) => ({
  inline_keyboard: [[
    { text: '✅ Confirm Payment', callback_data: `confirm:${studentId}` },
    { text: '❌ Reject', callback_data: `reject:${studentId}` },
  ]],
});

const ACTIONS = new Set(['paid', 'receipt', 'later', 'confirm', 'reject']);
// Actions that address no particular student — the parent's own help button.
const BARE_ACTIONS = new Set(['help']);

export const helpButton = () => ({
  inline_keyboard: [[{ text: '❓ How this works', callback_data: 'help' }]],
});

/**
 * Parses "action:studentId", rejecting anything else outright.
 *
 * callback_data is attacker-controlled in the sense that anyone who can reach
 * the bot can send an arbitrary string, so the shape is checked before the id
 * ever reaches a Firestore lookup.
 */
export function parseCallbackData(raw) {
  const value = String(raw || '');
  if (value.length > 64) return null;

  if (BARE_ACTIONS.has(value)) return { action: value, studentId: null };

  const cut = value.indexOf(':');
  if (cut < 1) return null;

  const action = value.slice(0, cut);
  const studentId = value.slice(cut + 1);
  if (!ACTIONS.has(action)) return null;
  // Firestore document ids: no slashes, no dots, non-empty, sane length.
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(studentId)) return null;

  return { action, studentId };
}
