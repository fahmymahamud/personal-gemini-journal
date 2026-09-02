import { GoogleGenAI } from '@google/genai';
import { lessonDaysOf } from './student-schema.js';

const MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const MAX_HISTORY_MESSAGES = 40;   // ~20 exchanges, plenty for refining one draft
const MAX_MESSAGE_CHARS = 4000;

let client;
function getClient() {
  if (!client) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      const err = new Error('GEMINI_API_KEY is not set');
      err.status = 503;
      throw err;
    }
    // AI Studio / Gemini Developer API — an apiKey client, not Vertex.
    client = new GoogleGenAI({ apiKey });
  }
  return client;
}

function money(amount, currency) {
  if (!amount) return 'no fee recorded';
  return `${currency || 'SGD'} ${Number(amount).toFixed(2)}`;
}

// The student's journal entry becomes part of the system instruction rather than
// a chat turn, so it stays in view for every refinement without cluttering the
// visible conversation.
function describeStudent(s) {
  if (!s) return null;
  const payer = s.payerName
    ? `${s.payerName}${s.payerPhone ? ` (${s.payerPhone})` : ''}`
    : 'the student themselves';
  const lesson = [lessonDaysOf(s).join('/'), s.lessonTime].filter(Boolean).join(' ') || 'not scheduled';

  return [
    `Name: ${s.name}`,
    `Student's phone: ${s.studentPhone || 'unknown'}`,
    `Who pays: ${payer}`,
    `Lesson slot: ${lesson}`,
    `Fee per lesson: ${money(s.feeAmount, s.feeCurrency)}`,
    `Payment status: ${s.paymentStatus || 'unknown'}`,
    `Last paid: ${s.lastPaidDate || 'no record'}`,
    s.notes ? `Coach's notes: ${s.notes}` : null,
  ].filter(Boolean).join('\n');
}

function buildSystemInstruction({ coachName, student }) {
  const today = new Date().toISOString().slice(0, 10);
  const lines = [
    "You are the assistant inside a private coaching journal. The coach is the only person you talk to; the students never see this chat.",
    `The coach is ${coachName || 'a private tutor'}. Today's date is ${today}.`,
    '',
    'Your job is to draft short reminder messages the coach will send over WhatsApp — payment chasers, lesson reminders, reschedule notes.',
    '',
    'How to write:',
    '- Singapore English, warm but direct. The coach knows these families personally.',
    '- Short. Two or three sentences is usually right; a WhatsApp message, not a letter.',
    '- Address the person who actually pays, using their name when you know it.',
    '- Name the exact amount and currency when money is involved. Never invent a figure, a date, or a PayNow number that is not in the record below — if the coach wants one included, ask for it.',
    '- At most one emoji, and only if it genuinely fits.',
    '- Never guilt-trip or threaten. A late payment is usually an oversight.',
    '',
    'Output format: reply with the message text alone, ready to copy and send. No preamble, no surrounding quotes, no "Here is a draft". The exception is when the coach asks you a question rather than requesting an edit — then just answer them normally.',
    '',
    'The coach will keep refining ("shorter", "add my PayNow number 91234567", "friendlier"). Each time, rewrite the whole message with that change applied and output the new version in full.',
  ];

  const record = describeStudent(student);
  if (record) {
    lines.push('', "The student's journal entry:", record);
  } else {
    lines.push('', 'No student is selected. If the coach asks for a message that needs a specific record, ask them to pick a student first.');
  }

  return lines.join('\n');
}

// The client owns the transcript, so treat it as untrusted: the Gemini API
// requires strictly alternating roles starting with 'user'.
export function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];

  const cleaned = [];
  for (const turn of history) {
    const role = turn?.role === 'model' ? 'model' : 'user';
    const text = typeof turn?.text === 'string'
      ? turn.text
      : turn?.parts?.map((p) => p?.text || '').join('') || '';
    const trimmed = String(text).trim().slice(0, MAX_MESSAGE_CHARS);
    if (!trimmed) continue;

    // Drop leading model turns, and fold consecutive same-role turns together.
    if (!cleaned.length && role === 'model') continue;
    const prev = cleaned[cleaned.length - 1];
    if (prev && prev.role === role) {
      prev.parts[0].text += `\n\n${trimmed}`;
      continue;
    }
    cleaned.push({ role, parts: [{ text: trimmed }] });
  }

  // Keep the tail, then re-trim so the window still opens on a 'user' turn.
  const windowed = cleaned.slice(-MAX_HISTORY_MESSAGES);
  while (windowed.length && windowed[0].role !== 'user') windowed.shift();
  // A trailing 'user' turn would collide with the message we are about to send.
  if (windowed.length && windowed[windowed.length - 1].role === 'user') windowed.pop();
  return windowed;
}

// The SDK rethrows upstream HTTP codes verbatim, so a retired model arrives as
// a bare 404 and depleted credits as a bare 429 — indistinguishable from our own
// "route not found" or a rate limit on this server. Relabel them with the fix.
function upstreamError(cause) {
  const raw = String(cause?.message || '');
  let status = 502;
  let message = `Gemini call failed using model "${MODEL}".`;

  if (/RESOURCE_EXHAUSTED|"code":\s*429/.test(raw)) {
    status = 429;
    message = 'Gemini quota exhausted — top up prepay credits in AI Studio (ai.studio/projects).';
  } else if (/no longer available|NOT_FOUND|"code":\s*404/.test(raw)) {
    message = `Gemini model "${MODEL}" is unavailable — update GEMINI_MODEL in .env.`;
  } else if (/API_KEY_INVALID|"code":\s*40[13]/.test(raw)) {
    message = 'Gemini rejected the API key — check GEMINI_API_KEY in .env.';
  }

  const err = new Error(message);
  err.status = status;
  err.expose = true;   // safe to show the coach: it names the fix, not internals
  err.cause = cause;
  return err;
}

export async function runChat({ history, message, student, coachName }) {
  const text = String(message || '').trim().slice(0, MAX_MESSAGE_CHARS);
  if (!text) {
    const err = new Error('Message cannot be empty');
    err.status = 400;
    throw err;
  }

  // Local debugging only. This names a key prefix and a student, neither of
  // which belongs in Cloud Logging, so it is off whenever NODE_ENV=production
  // (which Cloud Run sets). LOG_LEVEL=debug forces it back on if ever needed.
  if (process.env.NODE_ENV !== 'production' || process.env.LOG_LEVEL === 'debug') {
    console.log(`[gemini] model=${MODEL} key=${(process.env.GEMINI_API_KEY || '').slice(0, 8)}… ` +
      `student=${student?.name || 'none'} historyTurns=${sanitizeHistory(history).length}`);
  }

  const chat = getClient().chats.create({
    model: MODEL,
    history: sanitizeHistory(history),
    config: {
      systemInstruction: buildSystemInstruction({ coachName, student }),
      temperature: 0.7,
      maxOutputTokens: 1024,
    },
  });

  let response;
  try {
    response = await chat.sendMessage({ message: text });
  } catch (cause) {
    throw upstreamError(cause);
  }

  const reply = response.text?.trim();
  if (!reply) {
    const err = new Error('Gemini returned an empty response — try rephrasing');
    err.status = 502;
    throw err;
  }
  return reply;
}

export { MODEL, buildSystemInstruction };
