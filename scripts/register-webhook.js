// Registers the n8n webhook URL with Unipile for message.new events.
// Usage (PowerShell):  $env:UNIPILE_API_KEY="..."; $env:UNIPILE_ACCOUNT_ID="acc_..."; $env:WEBHOOK_URL="https://your-n8n/webhook/<path>"; node scripts/register-webhook.js
// The API key is read from the environment only. Never commit it.
const { UNIPILE_API_KEY, UNIPILE_ACCOUNT_ID, WEBHOOK_URL } = process.env;

if (!UNIPILE_API_KEY || !UNIPILE_ACCOUNT_ID || !WEBHOOK_URL) {
  console.error('Set UNIPILE_API_KEY, UNIPILE_ACCOUNT_ID and WEBHOOK_URL first.');
  process.exit(1);
}

(async () => {
  const res = await fetch('https://api.unipile.com/v2/webhooks/endpoints/', {
    method: 'POST',
    headers: { 'X-API-KEY': UNIPILE_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: WEBHOOK_URL,
      trigger_events: ['message.new'],
      account_ids: [UNIPILE_ACCOUNT_ID],
      description: 'LinkedIn auto-reply bot',
    }),
  });
  const body = await res.json().catch(() => ({}));
  console.log(res.status, JSON.stringify({ id: body.id, enabled: body.enabled, url: body.url, error: body.error }, null, 2));
  process.exit(res.ok ? 0 : 1);
})();
