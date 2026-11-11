// Builds the n8n workflow JSON from the sources in src/.
//
//   node scripts/build-workflow.js
//
// workflow.json              public version, with placeholders for ids and the webhook path
// local/workflow.import.json personal version, only written if local/overrides.json exists (git-ignored)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const prompt = read('src/system_prompt.md').trim();
const bio = read('src/bio.txt').trim();
const code = {
  splitInvitations: read('src/nodes/split_invitations.js'),
  parseEvent: read('src/nodes/parse_event.js'),
  decide: read('src/nodes/decide.js').replace('__SYSTEM_PROMPT__', JSON.stringify(prompt)),
  buildReply: read('src/nodes/build_reply.js'),
};

const DEFAULTS = {
  account_id: 'acc_REPLACE_ME',
  webhook_path: 'REPLACE_WITH_RANDOM_PATH',
  model: 'anthropic/claude-haiku-5.5',
  fallback_model: 'google/gemini-2.5-flash-lite',
  unipile_credential: { id: 'REPLACE', name: 'Unipile API Key' },
  openrouter_credential: { id: 'REPLACE', name: 'OpenRouter account' },
};

function build(o) {
  const UNIPILE = { httpHeaderAuth: o.unipile_credential };
  const OPENROUTER = { openRouterApi: o.openrouter_credential };
  const headerAuth = { authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth' };
  const assign = (name, value) => ({ id: name, name, value, type: 'string' });
  const wait = (amount) => ({ resume: 'timeInterval', amount, unit: 'seconds' }); // explicit: the default unit is HOURS

  const nodes = [
    // ---------------- Flow A: accept connection requests ----------------
    {
      name: 'Every 30 seconds',
      type: 'n8n-nodes-base.scheduleTrigger',
      typeVersion: 1.2,
      position: [0, 0],
      parameters: { rule: { interval: [{ field: 'seconds', secondsInterval: 30 }] } },
    },
    {
      name: 'Config (invites)',
      type: 'n8n-nodes-base.set',
      typeVersion: 3.4,
      position: [220, 0],
      parameters: { assignments: { assignments: [assign('account_id', o.account_id)] }, options: {} },
    },
    {
      name: 'List Received Invitations',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [440, 0],
      onError: 'continueRegularOutput',
      credentials: UNIPILE,
      parameters: {
        ...headerAuth,
        method: 'GET',
        url: '=https://api.unipile.com/v2/{{ $json.account_id }}/users/me/relation-requests?type=received',
        options: { timeout: 15000 },
      },
    },
    {
      name: 'Split Invitations',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [660, 0],
      parameters: { jsCode: code.splitInvitations },
    },
    {
      name: 'Accept Invitation',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [880, 0],
      onError: 'continueRegularOutput',
      retryOnFail: true,
      maxTries: 2,
      waitBetweenTries: 1000,
      credentials: UNIPILE,
      parameters: {
        ...headerAuth,
        method: 'POST',
        url: '=https://api.unipile.com/v2/{{ $json.account_id }}/users/me/relation-requests/{{ $json.request_id }}/accept',
        options: { timeout: 15000 },
      },
    },

    // ---------------- Flow B: answer direct messages ----------------
    {
      name: 'Incoming Message Webhook',
      type: 'n8n-nodes-base.webhook',
      typeVersion: 2,
      position: [0, 300],
      webhookId: crypto.createHash('sha1').update(o.webhook_path).digest('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, '$1-$2-$3-$4-$5'),
      parameters: { httpMethod: 'POST', path: o.webhook_path, responseMode: 'onReceived', options: {} },
    },
    {
      name: 'Parse Event',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [220, 300],
      parameters: { jsCode: code.parseEvent },
    },
    {
      name: 'Config (messages)',
      type: 'n8n-nodes-base.set',
      typeVersion: 3.4,
      position: [440, 300],
      parameters: {
        assignments: {
          assignments: [
            assign('model', o.model),
            assign('fallback_model', o.fallback_model),
            assign('owner_name', 'Koutaiba'),
            assign('owner_bio', bio),
          ],
        },
        includeOtherFields: true,
        options: {},
      },
    },
    {
      name: 'Debounce 5s',
      type: 'n8n-nodes-base.wait',
      typeVersion: 1.1,
      position: [660, 300],
      parameters: wait(5),
    },
    {
      name: 'Get Recent Messages',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [880, 300],
      onError: 'continueRegularOutput',
      credentials: UNIPILE,
      parameters: {
        ...headerAuth,
        method: 'GET',
        url: '=https://api.unipile.com/v2/{{ $json.account_id }}/chats/{{ $json.chat_id }}/messages?limit=15',
        options: { timeout: 15000 },
      },
    },
    {
      name: 'Decide',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [1100, 300],
      parameters: { jsCode: code.decide },
    },
    {
      name: 'LLM (OpenRouter)',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [1320, 300],
      onError: 'continueRegularOutput',
      retryOnFail: true,
      maxTries: 2,
      waitBetweenTries: 500,
      credentials: OPENROUTER,
      parameters: {
        method: 'POST',
        url: 'https://openrouter.ai/api/v1/chat/completions',
        authentication: 'predefinedCredentialType',
        nodeCredentialType: 'openRouterApi',
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ JSON.stringify($json.llm_request) }}',
        options: { timeout: 25000 },
      },
    },
    {
      name: 'Build Reply',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [1540, 300],
      parameters: { jsCode: code.buildReply },
    },
    {
      name: 'Typing Pause',
      type: 'n8n-nodes-base.wait',
      typeVersion: 1.1,
      position: [1760, 300],
      parameters: wait('={{ $json.delay_s }}'),
    },
    {
      name: 'Send Reply',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [1980, 300],
      retryOnFail: true,
      maxTries: 3,
      waitBetweenTries: 2000,
      credentials: UNIPILE,
      parameters: {
        ...headerAuth,
        method: 'POST',
        url: '=https://api.unipile.com/v2/{{ $json.account_id }}/chats/{{ $json.chat_id }}/messages/send',
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ JSON.stringify({ text: $json.text }) }}',
        options: { timeout: 20000 },
      },
    },
  ].map((n, i) => ({ id: `node-${i + 1}`, ...n }));

  const chain = (...names) => names.slice(0, -1).map((n, i) => [n, names[i + 1]]);
  const links = [
    ...chain('Every 30 seconds', 'Config (invites)', 'List Received Invitations', 'Split Invitations', 'Accept Invitation'),
    ...chain('Incoming Message Webhook', 'Parse Event', 'Config (messages)', 'Debounce 5s', 'Get Recent Messages',
      'Decide', 'LLM (OpenRouter)', 'Build Reply', 'Typing Pause', 'Send Reply'),
  ];
  const connections = {};
  for (const [from, to] of links) connections[from] = { main: [[{ node: to, type: 'main', index: 0 }]] };

  return {
    name: 'LinkedIn auto-accept and auto-reply',
    nodes,
    connections,
    settings: { executionOrder: 'v1', executionTimeout: 180 },
    active: false,
  };
}

const write = (file, wf) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(wf, null, 2) + '\n');
  console.log(`${path.relative(root, file)} written: ${wf.nodes.length} nodes`);
};

write(path.join(root, 'workflow.json'), build(DEFAULTS));

const overridesFile = path.join(root, 'local', 'overrides.json');
if (fs.existsSync(overridesFile)) {
  const overrides = JSON.parse(fs.readFileSync(overridesFile, 'utf8'));
  if (!overrides.webhook_path) { // generate once, keep stable so the URL registered with Unipile stays valid
    overrides.webhook_path = crypto.randomBytes(24).toString('hex');
    fs.writeFileSync(overridesFile, JSON.stringify(overrides, null, 2) + '\n');
  }
  write(path.join(root, 'local', 'workflow.import.json'), build({ ...DEFAULTS, ...overrides }));
  console.log(`webhook path: /webhook/${overrides.webhook_path}`);
}
