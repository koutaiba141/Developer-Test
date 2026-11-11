// Runs the real n8n Code-node sources against fake inputs (no n8n, no network, no secrets).
// Usage: node test/run-nodes.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', 'nodes', f), 'utf8');
const prompt = fs.readFileSync(path.join(__dirname, '..', 'src', 'system_prompt.md'), 'utf8');

function run(file, { input, nodes }) {
  let code = src(file).replace('__SYSTEM_PROMPT__', JSON.stringify(prompt));
  const $ = (name) => ({ first: () => ({ json: nodes[name] }) });
  const $input = { first: () => ({ json: input }) };
  return new Function('$', '$input', code)($, $input);
}

const cfg = { model: 'm', fallback_model: 'f', owner_name: 'Koutaiba', owner_bio: 'bio' };
const T = (s) => new Date(Date.UTC(2026, 10, 11, 12, 0, s)).toISOString();
const msg = (id, s, text, extra = {}) => ({ id, chat_id: 'c1', timestamp: T(s), text, is_sender: false, attachments: [], hyperlinks: [], ...extra });

function decide(listNewestFirst, trigger) {
  return run('decide.js', {
    input: { data: listNewestFirst },
    nodes: {
      'Config (messages)': cfg,
      'Parse Event': { account_id: 'acc_1', chat_id: 'c1', message_id: trigger.id, timestamp: trigger.timestamp, message: trigger },
    },
  });
}

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log('ok -', name); };

ok('parse_event drops our own messages', () => {
  const out = run('parse_event.js', { input: { body: { type: 'message.new', account_id: 'a', payload: msg('m1', 1, 'hi', { is_sender: true }) } }, nodes: {} });
  assert.strictEqual(out.length, 0);
});
ok('parse_event keeps incoming DMs', () => {
  const out = run('parse_event.js', { input: { body: { type: 'message.new', account_id: 'a', payload: msg('m1', 1, 'hi') } }, nodes: {} });
  assert.strictEqual(out[0].json.chat_id, 'c1');
});
ok('parse_event ignores other event types', () => {
  assert.strictEqual(run('parse_event.js', { input: { body: { type: 'message.update' } }, nodes: {} }).length, 0);
});
ok('three messages in a row: only the newest execution answers', () => {
  const [a, b, c] = [msg('1', 1, 'hey'), msg('2', 2, 'are you there'), msg('3', 3, 'one more thing')];
  const list = [c, b, a];
  assert.strictEqual(decide(list, a).length, 0);
  assert.strictEqual(decide(list, b).length, 0);
  const out = decide(list, c);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].json.flags.pending, 3);
  assert.strictEqual(out[0].json.llm_request.messages.length, 2); // system + merged user turn
});
ok('already answered (newest is ours): stay silent', () => {
  const a = msg('1', 1, 'hey');
  assert.strictEqual(decide([msg('2', 2, 'Hi!', { is_sender: true }), a], a).length, 0);
});
ok('trigger message not yet listed still gets answered', () => {
  const a = msg('1', 5, 'hello');
  assert.strictEqual(decide([msg('0', 1, 'old')], a).length, 1);
});
ok('empty message', () => {
  const out = decide([msg('1', 1, '')], msg('1', 1, ''));
  assert.ok(out[0].json.flags.isEmpty);
});
ok('single character', () => {
  assert.ok(decide([msg('1', 1, '?')], msg('1', 1, '?'))[0].json.flags.nearlyEmpty);
});
ok('emoji only', () => {
  assert.ok(decide([msg('1', 1, '\u{1F44B}\u{1F60A}')], msg('1', 1, '\u{1F44B}\u{1F60A}'))[0].json.flags.emojiOnly);
});
ok('very long message is cut', () => {
  const long = msg('1', 1, 'x'.repeat(5000));
  const out = decide([long], long)[0].json;
  assert.ok(out.flags.tooLong);
  assert.ok(out.llm_request.messages[1].content.length < 1400);
});
ok('link detected', () => {
  const m = msg('1', 1, 'check https://example.com/a');
  assert.ok(decide([m], m)[0].json.flags.hasLink);
});
ok('attachment-only message', () => {
  const m = msg('1', 1, '', { attachments: [{ type: 'file', filename: 'cv.pdf' }] });
  const out = decide([m], m)[0].json;
  assert.ok(out.flags.hasAttachment);
  assert.ok(out.llm_request.messages[1].content.includes('cv.pdf'));
});
ok('other language passes through untouched', () => {
  const m = msg('1', 1, 'مرحبا كيف حالك؟');
  assert.ok(decide([m], m)[0].json.llm_request.messages[1].content.includes('مرحبا'));
});
ok('conversation history keeps roles', () => {
  const list = [msg('3', 3, 'and you?'), msg('2', 2, 'Doing well!', { is_sender: true }), msg('1', 1, 'how are you')];
  const roles = decide(list, list[0])[0].json.llm_request.messages.map((x) => x.role);
  assert.deepStrictEqual(roles, ['system', 'user', 'assistant', 'user']);
});
ok('build_reply cleans markdown and dashes', () => {
  const out = run('build_reply.js', {
    input: { choices: [{ message: { content: '"**Sure** — happy to help!"' } }] },
    nodes: { Decide: { account_id: 'a', chat_id: 'c', fallback: 'fb' } },
  })[0].json;
  assert.strictEqual(out.text, 'Sure, happy to help!');
  assert.ok(out.delay_s >= 1 && out.delay_s <= 3);
});
ok('build_reply falls back when the LLM failed', () => {
  const out = run('build_reply.js', { input: { error: { message: 'boom' } }, nodes: { Decide: { account_id: 'a', chat_id: 'c', fallback: 'fb' } } })[0].json;
  assert.strictEqual(out.text, 'fb');
  assert.ok(out.used_fallback);
});
ok('split_invitations', () => {
  const out = run('split_invitations.js', { input: { data: [{ id: 'r1', user: { display_name: 'A' } }, { id: 'r2' }] }, nodes: { 'Config (invites)': { account_id: 'acc_1' } } });
  assert.strictEqual(out.length, 2);
  assert.strictEqual(run('split_invitations.js', { input: { error: 'x' }, nodes: { 'Config (invites)': { account_id: 'a' } } }).length, 0);
});

console.log(`\n${n} checks passed`);
