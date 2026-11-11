// Decides whether this execution should answer, and builds the LLM request.
//
// Every incoming message starts its own execution. After the debounce wait, only the execution whose
// message is still the newest in the chat continues; the others stop. Three messages in a row, one reply.
const SYSTEM_PROMPT = __SYSTEM_PROMPT__;
const MAX_CHARS = 1200; // longer messages are cut before going to the LLM
const HISTORY = 15;

const cfg = $('Config (messages)').first().json;
const ev = $('Parse Event').first().json;
const res = $input.first().json;

// Unipile returns newest first.
let list = Array.isArray(res.data) ? res.data.slice() : [];

if (list.length) {
  const idx = list.findIndex((m) => m.id === ev.message_id);
  if (idx > 0) return []; // a newer message exists: its execution will answer
  if (idx === -1) {
    // Our message is not listed yet (eventual consistency). Only continue if nothing newer is listed.
    if (new Date(list[0].timestamp) > new Date(ev.timestamp)) return [];
    list.unshift(ev.message);
  }
} else {
  // History call failed: answer from the webhook payload alone.
  list = [ev.message];
}

const ordered = list.slice(0, HISTORY).reverse(); // oldest -> newest

// Messages the other person sent since we last spoke.
const pending = [];
for (let i = ordered.length - 1; i >= 0 && !ordered[i].is_sender; i--) pending.unshift(ordered[i]);

// ---------- describe messages for the LLM ----------
const ATTACHMENT_LABEL = {
  img: '[image attached]',
  video: '[video attached]',
  audio: '[voice message attached]',
  shared_content: '[shared post or link attached]',
  contact_card: '[contact card attached]',
};

function describe(m) {
  const parts = [];
  const text = (m.text || '').trim();
  if (text.length > MAX_CHARS) {
    parts.push(`${text.slice(0, MAX_CHARS)} ... [message cut, ${text.length} characters in total]`);
  } else if (text) {
    parts.push(text);
  }
  for (const a of m.attachments || []) {
    if (a.type === 'file') parts.push(`[file attached: ${a.filename || 'unknown name'}]`);
    else parts.push(ATTACHMENT_LABEL[a.type] || '[attachment]');
  }
  if (!parts.length && !m.is_sender) parts.push('[empty message]');
  return parts.join('\n');
}

// ---------- situation flags for the last batch of incoming messages ----------
const texts = pending.map((m) => (m.text || '').trim());
const joined = texts.join(' ');
const hasAttachment = pending.some((m) => (m.attachments || []).length > 0);
const hasLink = /https?:\/\/|www\.|\b[a-z0-9-]+\.(com|io|net|org|co|ai|app|dev)\b\/?/i.test(joined)
  || pending.some((m) => (m.hyperlinks || []).length > 0);
const isEmpty = !hasAttachment && joined.length === 0;
const emojiOnly = joined.length > 0 && /^[\p{Extended_Pictographic}\p{Emoji_Component}‍️\s]+$/u.test(joined);
const nearlyEmpty = !isEmpty && !emojiOnly && !hasAttachment && joined.replace(/[\s.!?,]/g, '').length <= 1;
const tooLong = texts.some((t) => t.length > MAX_CHARS);

const notes = [];
if (pending.length > 1) notes.push(`${pending.length} messages arrived in a row: answer them together in one reply.`);
if (isEmpty) notes.push('The message is empty.');
if (nearlyEmpty) notes.push('The message is almost empty (a single character or punctuation).');
if (emojiOnly) notes.push('The message contains only emoji.');
if (tooLong) notes.push('The message was very long and has been cut.');
if (hasLink) notes.push('The message contains a link. You cannot open it.');
if (hasAttachment) notes.push('The message has an attachment you cannot view.');

// ---------- build chat history, merging consecutive same-role messages ----------
const messages = [];
for (const m of ordered) {
  const content = describe(m);
  if (!content) continue;
  const role = m.is_sender ? 'assistant' : 'user';
  const last = messages[messages.length - 1];
  if (last && last.role === role) last.content += `\n${content}`;
  else messages.push({ role, content });
}

const system = SYSTEM_PROMPT
  .replace(/\{\{owner_name\}\}/g, cfg.owner_name)
  .replace(/\{\{owner_bio\}\}/g, cfg.owner_bio)
  + (notes.length ? `\n\nSituation notes for this reply:\n- ${notes.join('\n- ')}` : '');

// ---------- fallback if the LLM is down: still never leave a message unanswered ----------
let fallback = "Thanks for your message! I'll get back to you properly soon.";
if (hasAttachment) fallback = "Thanks for sharing! I can't open attachments here, could you tell me in a message what it's about?";
else if (isEmpty || nearlyEmpty) fallback = 'Hi! Your message seems to have come through empty. What did you want to say?';
else if (hasLink) fallback = "Thanks! I can't open links here, could you sum it up in a sentence?";

return [
  {
    json: {
      account_id: ev.account_id,
      chat_id: ev.chat_id,
      fallback,
      flags: { pending: pending.length, hasLink, hasAttachment, isEmpty, nearlyEmpty, emojiOnly, tooLong },
      llm_request: {
        // OpenRouter tries these in order, so one provider outage does not leave a message unanswered.
        models: [cfg.model, cfg.fallback_model].filter(Boolean),
        messages: [{ role: 'system', content: system }, ...messages],
        reasoning: { enabled: false }, // short chat reply: no hidden thinking tokens eating the budget or adding delay
        max_tokens: 300,
        temperature: 0.8,
      },
    },
  },
];
