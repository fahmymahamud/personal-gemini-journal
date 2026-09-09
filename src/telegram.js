// One place that knows how to talk to the Bot API. The /send route and the
// reminder scheduler both go through here, so a change to how we call Telegram
// cannot drift between the two.

export const MAX_MESSAGE_CHARS = 4096;   // Telegram's own sendMessage limit

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
 * Sends one message. Resolves with an outcome rather than throwing, because
 * the scheduler sends in bulk: one blocked chat must not abort the sweep.
 * Callers that want an exception (the /send route) raise it themselves from
 * the returned shape.
 *
 * @returns {{ok: boolean, messageId: number|null, description: string|null, status: number}}
 */
export async function sendTelegramMessage(chatId, message) {
  const text = String(message || '').trim().slice(0, MAX_MESSAGE_CHARS);
  if (!text) return { ok: false, messageId: null, description: 'Message cannot be empty', status: 400 };

  let response;
  let data = {};
  try {
    response = await fetch(`https://api.telegram.org/bot${botToken()}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
    data = await response.json().catch(() => ({}));
  } catch (cause) {
    // Network-level failure: no HTTP status to report.
    return { ok: false, messageId: null, description: cause.message, status: 0 };
  }

  if (!response.ok || !data.ok) {
    // Telegram's own wording is the useful part ("chat not found", "bot was
    // blocked by the user"), so it is passed back rather than flattened.
    return {
      ok: false,
      messageId: null,
      description: data.description || `HTTP ${response.status}`,
      status: response.status,
    };
  }

  return { ok: true, messageId: data.result?.message_id ?? null, description: null, status: 200 };
}
