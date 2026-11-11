// Keep only incoming DMs. message.new also fires for messages the bot sends itself,
// so is_sender has to be filtered out or it would answer its own replies.
const input = $input.first().json;
const body = input.body || input;

if (body.type !== 'message.new') return [];

const m = body.payload || {};
if (!m.id || !m.chat_id) return [];
if (m.is_sender || m.is_event || m.is_deleted || m.is_hidden) return [];

return [
  {
    json: {
      account_id: body.account_id,
      chat_id: m.chat_id,
      message_id: m.id,
      timestamp: m.timestamp,
      message: m,
    },
  },
];
