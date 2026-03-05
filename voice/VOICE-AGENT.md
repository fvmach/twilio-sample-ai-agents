# ConversationRelay Voice Agent

Real-time AI voice agent built on Twilio Conversation Relay and OpenAI.

Twilio handles STT and TTS. This server handles the conversation logic — receiving transcribed speech, pre-fetching customer context, retrieving relevant knowledge, calling the LLM, executing tool calls directly against configured APIs, and streaming tokens back as speech.

---

## How It Works

```
Caller
  │
  │  PSTN / SIP / Twilio Client
  ▼
Twilio Voice
  │
  │  TwiML → <ConversationRelay url="wss://your-domain.ngrok.io">
  ▼
ngrok tunnel  (your-domain.ngrok.io → localhost:8080)
  │
  ▼
voice/server.js  (WebSocket server)
  │
  ├── setup → create session, fire 3 pre-fetches concurrently
  ├── prompt → await pre-fetches + RAG, build context, LLM stream + tool loop → text SPI
  ├── interrupt  → abort LLM stream, send immediate ACK phrase, store utterance
  ├── dtmf → log keypress
  ├── error → log Twilio error
  └── info → silently ignored (round-trip delay, speaking state, etc.)
```

---

## SPI Message Flow

### Received from Twilio

| type | key fields | when |
|------|-----------|------|
| `setup` | `callSid`, `from`, `to`, `direction`, `customParameters` | On WebSocket connect |
| `prompt` | `voicePrompt`, `lang`, `last` | Each time caller finishes speaking |
| `interrupt` | `utteranceUntilInterrupt`, `durationUntilInterruptMs` | Caller speaks over the bot |
| `dtmf` | `digit` | Keypad press (when enabled in TwiML) |
| `info` | `name`, `value` | Diagnostics from Twilio (round-trip ms, speaking state, etc.) |
| `error` | `description` | Session or validation error from Twilio |

### Sent to Twilio

| type | key fields | purpose |
|------|-----------|---------|
| `text` | `token`, `last`, `interruptible`, `preemptible` | Stream LLM response to TTS |
| `end` | `handoffData` | Terminate the call session (after handover tool) |
| `language` | `ttsLanguage`, `transcriptionLanguage` | Switch language mid-call |

---

## Session Lifecycle

Each WebSocket connection = one call = one `Session` object.

```
WebSocket connect
  └── Session created
 │
 ├── fetchConversationsContext(from)  → session.contextPromise
 ├── fetchSegmentProfile(from) → session.profilePromise
 └── fetchBankingData(from) → session.bankingPromise
 │
 │  (all three resolve in parallel while caller is greeted)
 │
 ├── prompt / interrupt / dtmf messages handled
 │
WebSocket close
  └── In-flight LLM stream aborted, session deleted
```

Session fields:

| Field | Description |
|-------|-------------|
| `callSid` | Twilio call identifier |
| `from` / `to` | Caller / called identity |
| `history` | OpenAI message array for this call |
| `summary` | Plain-text summary of compacted older turns |
| `hasMutated` | `true` after `invest_money` succeeds |
| `abortController` | Cancels in-flight LLM stream on interrupt |
| `contextPromise` | Pre-fetched Twilio Conversations data |
| `profilePromise` | Pre-fetched Segment profile |
| `bankingPromise` | Pre-fetched banking data |
| `lastInterruptUtterance` | What the caller said when interrupting (used next turn) |
| `lastLang` | Most recent STT language tag (e.g. `pt-BR`) |

Sessions are scoped to the WebSocket connection — no persistence across calls.

---

## Prompt Handling (Critical Path)

Each `prompt` message triggers this sequence, optimised for minimum latency:

```
1. Caller speaks →  Twilio STT  →  `prompt` SPI message arrives
2. session.lastLang updated from message.lang
3. Silence guard started — gpt-4o-mini interstitial LLM fires immediately (in parallel)
4. User text added to session.history
5. All pre-fetches + RAG search awaited concurrently:
 Promise.all([
 searchKnowledge(userText), ← LanceDB embed + search (≤150ms timeout)
 session.contextPromise, ← already settling since onSetup
 session.profilePromise, ← already settling since onSetup
 session.bankingPromise, ← already settling since onSetup
 ])
6. Build system messages (ordered for prompt-cache prefix stability):
 [ SYSTEM_PROMPT, ← static — always cached
 customer identity, ← per-session stable
 Segment profile, ← per-session stable
 banking data, ← per-session stable (changes after mutations)
 past conversation history, ← per-session stable
 call summary, ← grows slowly
 interrupt context, ← per-turn ephemeral (placed here to avoid breaking cache)
 RAG context ] ← per-turn dynamic (always last)
7. LLM while loop (max 10 iterations):
 a. If iter > 1: restart silence guard for post-tool LLM calls
 b. OpenAI streaming call (model, tools, max_completion_tokens: 400,
 parallel_tool_calls: true, stream_options: include_usage)
 c. Text tokens → sent to TTS immediately, token by token
 First token → stopSilenceGuard()
 d. tool_calls → collect all tool deltas by index
 e. On finish_reason === 'tool_calls':
 → execute ALL tools concurrently via Promise.all
 → append tool results to history
 → check mutations, check _endCall flags
 → continue loop
 f. On finish_reason === 'stop':
 → end-of-utterance marker sent (last: true, empty token)
 → assistant response added to history
 → history compacted if it exceeds threshold
 → sendEnd() if any tool set _endCall: true
```

If the knowledge database has not been seeded, RAG returns `null` and is silently skipped. All pre-fetches are null-safe.

---

## Interrupt Handling

When the caller speaks over the bot, Twilio sends an `interrupt` message. The server:

1. Aborts the in-flight LLM stream (`session.abortController.abort()`)
2. Sends an immediate ACK phrase to TTS (`interruptible: true`) so the call never goes silent:
 - Portuguese: "I'm listening!", "Go ahead!", "Sure, go ahead!"
 - English: "I'm listening!", "Go ahead!", "Sure, go ahead!"
 - Spanish: "¡Adelante!", "¡Te escucho!", "¡Dime!"
3. Stores `utteranceUntilInterrupt` in `session.lastInterruptUtterance`

On the next `prompt`, the stored utterance is injected as a system message so the LLM knows where it was interrupted and can acknowledge the topic shift naturally. The context is consumed and cleared after one use.

---

## Silence Guard and Interstitials

A silence guard starts at prompt receipt (before any `await`). It fires interstitial messages if the LLM has not produced its first token yet.

```
prompt received
  │
  ├── gpt-4o-mini call fires immediately (parallel, max 20 tokens)
  │ → contextual filler phrase tailored to the user's request
  │
  ├── t+5s  → if no first token: send LLM-generated phrase (or "Just a moment..." fallback)
  └── t+15s → if still no first token: send empathetic long-wait phrase
```

Interstitials are `preemptible: true` — when real LLM tokens arrive, Twilio immediately replaces the interstitial with the actual response.

The silence guard restarts at the beginning of every LLM iteration after tool calls, ensuring coverage while waiting for the post-tool LLM response too.

---

## Prompt Caching

System messages are ordered so the stable prefix is as long as possible across turns within the same call:

```
[0] SYSTEM_PROMPT ← static, never changes
[1] customer identity ← stable for the whole call
[2] Segment profile ← stable for the whole call
[3] banking data ← stable until a mutation (invest_money)
[4] conversation history ← stable for the whole call
[5] call summary ← grows slowly as history is compacted
[6] interrupt context ← ephemeral per-turn (placed after stable block)
[7] RAG context ← dynamic per-turn (always last)
```

OpenAI automatically caches the longest matching prefix in 128-token blocks (requires ≥1024 tokens total). From turn 2 onwards, the stable prefix (typically 1500+ tokens with profile/banking/history context) is served from cache — reducing input processing latency by up to 80%. Cache hits are logged: `LLM ← done | ... | cache: N tokens`.

---

## Context Compacting

After each completed turn, if `session.history` exceeds 10 messages, the oldest turns are collapsed into a plain-text summary:

```
Earlier in this call:
User: What's my balance?
[Tools called: get_banking_data]
Assistant: Your current balance is ...
User: Invest five hundred in Smart Savings.
[Tools called: invest_money]
Assistant: Done, I've invested ...
```

The summary is injected as a system message on subsequent turns, giving the agent full call memory without unbounded context growth.

After any state-changing tool call (`invest_money`), `get_banking_data` is re-enabled for the following LLM iteration so the agent can fetch an updated balance without relying on stale pre-fetched data.

---

## RAG Integration

Knowledge retrieval is handled by the shared `knowledge/` module at the repo root.

- Embedding model: `text-embedding-3-small`
- Top-K results: 3 chunks per turn
- Chunk size: 400 characters with 80-character overlap
- Timeout: 150ms — if embedding takes longer, RAG is skipped for that turn
- Context injected as a `system` message, placed last to avoid breaking the prompt-cache prefix
- Silently skipped if the DB is missing or no results pass the similarity threshold

See [../knowledge/](../knowledge/) for ingestion instructions.

---

## Tools

The agent has access to 9 tools. All except the two handover tools are implemented as direct API calls — no intermediate Twilio Function hop.

| Tool | Backend | Notes |
|------|---------|-------|
| `get_banking_data` | Twilio Sync (direct) | Pre-fetched on setup; re-enabled after mutations |
| `get_investment_data` | Twilio Sync (direct) | Portfolio + available products |
| `get_customer_profile` | Segment Profiles API (direct) | Pre-fetched on setup |
| `get_last_segment_events` | Segment Events API (direct) | Pre-fetched on setup |
| `get_stocks_data` | Alpha Vantage + Twelve Data fallback (direct) | Supports stocks, news, company-info, etf |
| `pix_transfer (remove if not needed)` | — | Always rejected on voice — customer directed to app or chat |
| `invest_money` | Twilio Sync (direct) | Confirm product and amount before calling |
| `studio_handover` | Twilio Function | Credit card delivery — ends session after LLM speaks |
| `flex_handover` | Twilio Function | Transfer to human agent — ends session after LLM speaks |

Tool calls within a single LLM turn are executed concurrently via `Promise.all`.

### Tool rules (in system prompt)

- **Always speak before calling a tool** — the LLM must emit a brief acknowledgement first, so TTS starts playing immediately while the tool runs
- Credit card delivery status → `studio_handover`
- Customer asks for human, or request cannot be fulfilled → `flex_handover`
- Always confirm product and amount before calling `invest_money`
- When discussing stocks, always remind the customer they are solely responsible for investment decisions

---

## Proactive Context Pre-fetches

Three requests fire immediately on `setup` — before the first `prompt` arrives — so the LLM has full customer context from turn one.

| Promise | Source | Injected as |
|---------|--------|-------------|
| `fetchConversationsContext` | Twilio Conversations API (direct, parallel) | Customer's past conversation history |
| `fetchSegmentProfile` | Segment Profiles API (direct) | Customer profile traits |
| `fetchBankingData` | Twilio Sync (direct, parallel 4-item fetch) | Account balance, credit, loyalty points, transactions |

`fetchConversationsContext` fetches the last 5 participant conversations and retrieves messages for the top 3 concurrently via `Promise.all` — eliminating the sequential API call pattern that caused 5–12s latency in the previous Function-based implementation.

All three are null-safe. If a service is unavailable, that context block is silently omitted.

---

## Identity Normalisation

Twilio Client calls arrive with `from` in the form `client:user@example.com`. All internal services expect the raw identity.

`normalizeIdentity(from)` strips the `client:` prefix. It is applied:
- In every pre-fetch before sending to a backend
- In `executeTool` for `userIdentity`, `userId`, and `email` args
- In the identity system message shown to the LLM

---

## Latency Design

All logging is decoupled from the SPI critical path via an async queue (`setImmediate`). Key optimisations:

| Technique | What it does |
|-----------|-------------|
| Pre-fetches on `setup` | All context resolved before first `prompt` |
| `Promise.all` for pre-fetches | Conversations, Segment, Sync fetched concurrently |
| `Promise.all` for tool calls | Multiple tools in one turn run concurrently |
| LLM-generated interstitials | `gpt-4o-mini` fires at prompt receipt to produce a contextual filler phrase |
| Pre-tool acknowledgement | LLM must speak before every tool call, so TTS starts before tool resolves |
| Silence guard per iteration | Restarts after tool calls for coverage on subsequent LLM calls |
| Interrupt ACK | Immediate TTS response on interrupt — no silent gap |
| Prompt cache ordering | Static context first, dynamic last — prefix cached from turn 2 onwards |
| `max_completion_tokens: 400` | Caps response length; signals expected output size to the API |
| `parallel_tool_calls: true` | Explicit; LLM may emit multiple tool calls in one turn |
| RAG timeout 150ms | Never delays the LLM call |
| Token streaming | Sent to TTS immediately, token by token — no buffering |
| Async log queue | Logging never blocks the message loop |

---

## Setup

### Prerequisites

- Node.js 20+
- ngrok account with a reserved domain
- Twilio account with Conversation Relay enabled
- OpenAI API key
- Segment Space ID and Access Secret (optional — skipped if not set)

### Install and run

```bash
cd voice
cp .env.example .env
# fill in .env with your credentials
npm install
npm start
```

On startup:

```
ConversationRelay Voice Server
 Local:  ws://localhost:8080
 Model:  gpt-4o
 Public: wss://your-domain.ngrok.io

 TwiML ConversationRelay URL:
 wss://your-domain.ngrok.io
```

### TwiML Bin

Create a TwiML Bin in the Twilio Console:

```xml
<Response>
  <Connect>
 <ConversationRelay
 url="wss://your-domain.ngrok.io"
 welcomeGreeting="Hi, this is the agent from . How can I help you today?"
 />
  </Connect>
</Response>
```

Assign to your Twilio phone number under **Voice & Fax → A call comes in**.

---

## Logging

Every SPI message in and out is logged with a timestamp, direction, and type. Logging is async — it never blocks the message loop.

```
[timestamp] i  Pre-fetch | segment-profile | 1008ms | ok
[timestamp] i  LLM → request | iter 1 | 5 messages | 7 tools
[timestamp] i  Interstitial (5s) | "Claro! Um momento enquanto eu verifico."
[timestamp] i  LLM ← first token | 8975ms TTFT
[timestamp] i  LLM ← done | 9461ms total | finish: stop | 155 chars | cache: 1280 tokens
[timestamp] *  tool call | invest_money { "amount": 3000, ... }
[timestamp] *  tool result | invest_money (2495ms) → {"success":true,...}
[timestamp] i  Interrupt | ACK: "I'm listening!" | spoken: "Hmm..." | after 1240ms
```

`←` cyan = received from Twilio
`→` yellow = sent to Twilio
`*` green = tool call / tool result
`cache: N tokens` = prompt cache hit on that turn

LLM timing logged at four points per iteration: `request` → `stream ready` (TTFB) → `first token` (TTFT) → `done` (total + cache).

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENAI_API_KEY` | Yes | — | OpenAI API key |
| `OPENAI_MODEL` | — | `gpt-5-mini` | Chat completions model. Use `gpt-4o` for lowest latency |
| `TWILIO_ACCOUNT_SID` | Yes | — | Twilio account SID |
| `TWILIO_AUTH_TOKEN` | Yes | — | Twilio auth token |
| `NGROK_DOMAIN` | — | — | Custom ngrok domain (auto-connects on start) |
| `NGROK_AUTHTOKEN` | — | — | ngrok auth token |
| `PORT` | — | `8080` | Local server port |
| `SEGMENT_SPACE_ID` | — | — | Segment Space ID for Profiles API (skipped if missing) |
| `SEGMENT_ACCESS_SECRET` | — | — | Segment access token for Profiles API (skipped if missing) |
| `SYNC_SERVICE_SID` | — | — | Twilio Sync Service SID for banking/investment data |
| `ALPHA_VANTAGE_API_KEY` | — | — | Alpha Vantage key for `get_stocks_data` (free at alphavantage.co) |
| `TWELVE_DATA_API_KEY` | — | — | Optional Twelve Data fallback for stocks if Alpha Vantage rate-limits |
