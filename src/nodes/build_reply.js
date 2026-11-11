// Cleans the model output so it reads like typed chat text, and picks a short typing delay.
const d = $('Decide').first().json;
const r = $input.first().json;

let text = r && r.choices && r.choices[0] && r.choices[0].message ? r.choices[0].message.content : '';
if (Array.isArray(text)) text = text.map((p) => p.text || '').join('');

function clean(t) {
  return String(t || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\*\*|__|`/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\s+[—–]\s+/g, ', ')
    .replace(/[—–]/g, '-')
    .replace(/^["'“]+|["'”]+$/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 700);
}

text = clean(text);

// Never send something that looks like a prompt leak.
if (/system prompt|situation notes/i.test(text)) text = '';

const usedFallback = !text;
if (usedFallback) text = d.fallback;

return [
  {
    json: {
      account_id: d.account_id,
      chat_id: d.chat_id,
      text,
      used_fallback: usedFallback,
      delay_s: 1 + Math.floor(Math.random() * 3), // 1-3 s "typing" pause on top of the debounce
    },
  },
];
