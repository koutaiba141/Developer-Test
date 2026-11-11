# LinkedIn auto-accept and auto-reply

An n8n workflow that runs on one LinkedIn account and does two things on its own:

1. Accepts incoming connection requests.
2. Answers direct messages with a short reply written by an LLM.

It only reacts. It never writes first, never sends invitations and never sends bulk messages.

LinkedIn has no official API for this, so the account is connected through [Unipile](https://developer.unipile.com/v2.0/docs/welcome), which exposes LinkedIn over a REST API and webhooks. The LLM is called through OpenRouter.

## How it works

**Connection requests.** Every 30 seconds the workflow lists the pending received invitations and accepts each one. Unipile has no webhook for new invitations, so this is polling; acceptance can take up to 30 seconds.

**Messages.** Unipile sends a `message.new` webhook for every message in the account, including the ones the bot sends, so the first step drops anything where `is_sender` is true. Then:

1. Wait 5 seconds. Every message starts its own execution, so this gives a burst of messages time to arrive.
2. Load the last 15 messages of the chat. If a newer message from the other person exists, this execution stops and the newer one answers. Three messages in a row produce one reply that covers all three. No shared state is needed for this.
3. Build the prompt: system prompt, the owner's short bio, the chat history, plus a few notes about the situation (empty message, link, attachment, and so on).
4. Call the model. OpenRouter falls back to a second model if the first one fails.
5. Clean up the text (no markdown, no dashes, capped length), pause 1 to 3 seconds, send the reply into the same chat.

If the LLM call fails completely, a short fixed reply goes out instead, so a message is never left unanswered.

## Unusual messages

The logic is in [`src/nodes/decide.js`](src/nodes/decide.js) and the instructions to the model are in [`src/system_prompt.md`](src/system_prompt.md).

| Case | What happens |
|---|---|
| The bot's own messages | Dropped before anything else, so it cannot answer itself |
| Several messages in a row | One reply for the whole burst |
| Empty, or a single character | Flagged to the model, which asks what they meant |
| Emoji only | Flagged, short friendly reply |
| Very long message | Cut at 1200 characters, the reply goes to the main point |
| Another language | Model answers in the language of the sender |
| Link | Never opened. The bot says it cannot open links and asks for a summary |
| File, image, voice note, video | Shown to the model as `[file attached: name]` and so on. The bot says it cannot view it and asks for a description |
| Rude message | Calm, one short line, no arguing |
| Question the bot cannot know | No invented facts. It says it will check and get back |
| "Ignore your instructions", off-topic requests | Declines lightly and stays in role. A reply that looks like a prompt leak is replaced by the fallback |
| "Are you a bot?" | Answers honestly that it is an automated assistant |

## Setup

You need Node.js (only for the build step and the tests), an n8n instance that is reachable over public HTTPS, a Unipile account with the LinkedIn account connected, and an OpenRouter key.

1. In n8n, create a Header Auth credential for Unipile (header `X-API-KEY`) and an OpenRouter credential.
2. Create `local/overrides.json` (the folder is git-ignored):
   ```json
   {
     "account_id": "acc_...",
     "unipile_credential": { "id": "<n8n credential id>", "name": "<credential name>" },
     "openrouter_credential": { "id": "<n8n credential id>", "name": "<credential name>" }
   }
   ```
3. Run `node scripts/build-workflow.js`. It writes `local/workflow.import.json` with a random webhook path. Without an overrides file it only rebuilds the public `workflow.json`, which has placeholders you can also edit by hand after importing.
4. Import `local/workflow.import.json` into n8n and activate it.
5. Register the production webhook URL (`https://<your-n8n>/webhook/<path>`) with Unipile for the `message.new` event, either in their dashboard or with the script:
   ```powershell
   $env:UNIPILE_API_KEY="..."; $env:UNIPILE_ACCOUNT_ID="acc_..."; $env:WEBHOOK_URL="https://<your-n8n>/webhook/<path>"; node scripts/register-webhook.js
   ```

The model and the bio are set in the `Config (messages)` node. Their defaults come from [`src/bio.txt`](src/bio.txt) and the build script.

To check the node logic without n8n or any network access: `node test/run-nodes.js`.

## Layout

```
workflow.json            importable workflow, placeholders for ids and secrets
src/system_prompt.md     instructions for the model
src/bio.txt              short background used as context
src/nodes/*.js           the code of each n8n Code node
scripts/                 build-workflow.js, register-webhook.js
test/run-nodes.js        runs the node code against fake inputs
```

## Limits

- It cannot read images, files, voice notes or links. It says so instead of guessing.
- The webhook is protected only by a long random path. Unipile signs its requests (`unipile-signature`) and checking that signature would be better.
- The 5 second debounce is stateless. If Unipile loses the webhook for the last message of a burst, that burst gets no reply, and there is no polling fallback for messages.
- Context is the last 15 messages of the chat, nothing longer term.
- Only the first 50 pending invitations are read on each tick. `limit` must be set explicitly: without it the Unipile endpoint returned an empty list even with a request pending.
- Automating a LinkedIn account goes against LinkedIn's terms and can get it restricted. Use an account you can afford to lose.

No credentials or message data are stored in this repository.
