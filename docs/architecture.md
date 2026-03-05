# Architecture

Technical reference for the AI agent system.

---

## Overview

The system is a multi-channel AI agent platform built on Twilio Conversation Relay. Each channel is an isolated Node.js process that:

1. Receives real-time events from Twilio over a WebSocket (the Conversation Relay SPI)
2. Enriches context from external systems (Segment, Twilio Sync, Twilio Conversations)
3. Queries a local vector database (LanceDB) for relevant knowledge
4. Calls an OpenAI chat completions model with streaming and tool use
5. Streams tokens back to Twilio for real-time TTS

No state is shared between channels at runtime. The only shared artifact is the `knowledge/` module, which provides a read-only `searchKnowledge()` function backed by a LanceDB database on disk.

---

## Conversation Relay Protocol

Twilio Conversation Relay (CR) replaces the traditional media + ASR pipeline with a simple WebSocket SPI. Twilio handles:
- PSTN / SIP / WebRTC inbound calls
- Speech-to-text transcription
- Text-to-speech synthesis and playback
- Barge-in (caller speaking over the bot → `interrupt` message)

The server only sees text in and sends text out.

### Message types received from Twilio

```
setup → call established, session parameters
prompt → transcribed caller speech (includes lang tag)
interrupt → caller spoke over the bot (includes utteranceUntilInterrupt)
dtmf → keypad digit
info → diagnostics (RTT, speaking state) — high frequency, discarded
error → Twilio-side session error
```

### Message types sent to Twilio

```
text → stream LLM tokens to TTS (token, last, interruptible, preemptible)
end → terminate the session (used after handover tool calls)
language → change STT/TTS language mid-call
```

`preemptible: true` text messages are replaced by the next non-preemptible message. Used for interstitials — they are automatically displaced when the real LLM response arrives.

---

## Tool Backends

All tools call external APIs directly from the voice server process — no intermediate Twilio Function hop, except for the two handover tools which require Flex / TaskRouter context.

| Tool | Direct backend |
|------|---------------|
| `get_banking_data` | Twilio Sync REST API |
| `get_investment_data` | Twilio Sync REST API |
| `invest_money` | Twilio Sync REST API |
| `get_customer_profile` | Segment Profiles API (`/traits`) |
| `get_last_segment_events` | Segment Profiles API (`/events`) |
| `get_stocks_data` | Alpha Vantage (primary) + Twelve Data (fallback) |
| `studio_handover` | Twilio Function (complex call routing logic) |
| `flex_handover` | Twilio Function (TaskRouter interaction) |

Tool calls within a single LLM turn are executed concurrently via `Promise.all`.

---

## Voice Server

### Session model

Each inbound call creates a `Session` object scoped to the WebSocket connection:

```js
{
 callSid, // Twilio call identifier
 from, // caller identity (e.g. client:user@example.com)
 to, // called number
 history, // OpenAI message array for this call
 summary, // plain-text summary of compacted history
 hasMutated, // true after invest_money succeeds
 abortController, // cancels in-flight LLM stream on interrupt
 contextPromise, // pre-fetched Twilio Conversations data
 profilePromise, // pre-fetched Segment profile
 bankingPromise, // pre-fetched banking data
 lastInterruptUtterance, // what the caller said when they interrupted
 lastLang, // most recent STT language tag (e.g. 'pt-BR')
}
```

### Pre-fetches

On `setup`, three requests fire concurrently before the first `prompt` arrives:

```
setup received
 │
 ├─► fetchConversationsContext() → Twilio Conversations API (direct)
 │ Lists last 5 participant conversations, then fetches messages
 │ for top 3 concurrently via Promise.all — no sequential calls
 │
 ├─► fetchSegmentProfile() → Segment Profiles API (direct)
 │
 └─► fetchBankingData() → Twilio Sync (direct)
 4 items fetched concurrently: account_balance, credit_card,
 loyalty_points, investment_balance
```

By the time the caller finishes speaking their first sentence, all three are resolved (or have failed gracefully). This eliminates cold-start latency on the first LLM call.

### Prompt handling loop

```
prompt received
 │
 ├── session.lastLang updated from message.lang
 ├── silence guard started
 │ └── gpt-4o-mini fires immediately for contextual interstitial phrase
 ├── user message appended to history
 │
 ├── Promise.all([RAG search ≤150ms, contextPromise, profilePromise, bankingPromise])
 │
 ├── system messages assembled (cache-ordered):
 │ [0] SYSTEM_PROMPT ← static
 │ [1] customer identity ← per-session stable
 │ [2] Segment profile ← per-session stable
 │ [3] banking data ← stable until mutation
 │ [4] conversation history ← per-session stable
 │ [5] call summary ← grows slowly
 │ [6] interrupt context ← ephemeral, placed after stable block
 │ [7] RAG context ← per-turn dynamic, always last
 │
 └── while loop (max 10 iterations):
 │
 ├── if iter > 1: restart silence guard
 ├── activeTools computed (get_banking_data excluded unless hasMutated)
 ├── OpenAI streaming call:
 │ model, tools, parallel_tool_calls: true,
 │ max_completion_tokens: 400, stream_options: {include_usage: true}
 │
 ├── text token received → send to TTS immediately; first token → stopSilenceGuard()
 │
 ├── finish_reason === 'tool_calls'
 │ → execute all tools concurrently via Promise.all
 │ → append tool results to history
 │ → check mutations (hasMutated), check _endCall flags
 │ → continue loop
 │
 └── finish_reason === 'stop'
 → send end-of-utterance marker (last: true, empty token)
 → append assistant message
 → maybeCompact(session)
 → break
```

### Interrupt handling

When `interrupt` fires:
1. `session.abortController.abort()` — LLM stream cancelled immediately
2. `session.lastInterruptUtterance` set to `message.utteranceUntilInterrupt`

On the next `prompt`, the stored utterance is injected as a system message so the LLM acknowledges the topic shift at the start of its response. Consumed and cleared after one use.

### Silence guard and interstitials

```
prompt received
 │
 ├── gpt-4o-mini fires immediately (max_tokens: 20)
 │ generates contextual filler phrase for this specific user request
 │
 ├── t+5s → if no first token yet:
 │ send LLM-generated phrase (or 'Só um instante...' fallback)
 │ as preemptible: true
 │
 └── t+15s → if still no first token:
 send empathetic long-wait phrase as preemptible: true
```

The guard restarts at the beginning of every LLM iteration after tool calls (e.g. while waiting for the post-tool response). Both timers fire relative to the current iteration start.

### Context compacting

After each completed turn, if `session.history` exceeds 10 messages, older turns are collapsed into a plain-text transcript stored in `session.summary`:

```
Earlier in this call:
User: <utterance>
[Tools called: <tool_name>, ...]
Assistant: <response>
```

`session.summary` is injected as system message [5] (after stable context, before ephemeral) on every subsequent turn. This keeps the LLM input size bounded while preserving full call memory.

### Mutation tracking

`invest_money` changes account state. After a successful mutation, `session.hasMutated = true`. On the next LLM iteration, `get_banking_data` is added back to `activeTools` so the model can fetch an up-to-date balance — enabling multi-step commands like "invest 100 reais and tell me my new balance" within a single voice turn.

### Prompt caching

OpenAI automatically caches the longest matching prefix in 128-token blocks (requires ≥1024 tokens). The system message order is deliberately structured so the stable session prefix (SYSTEM_PROMPT + identity + profile + banking + conversations + summary) is as long as possible and doesn't change between turns. Only the ephemeral interrupt context and per-turn RAG context vary.

From turn 2 onwards in a typical conversation (context ~1500–2500 tokens), the stable prefix is served from cache — reducing input processing latency by up to 80%. Cache hits appear in the done log: `LLM ← done | ... | cache: N tokens`.

### Pre-tool acknowledgement

The system prompt mandates that the LLM always speaks before calling any tool:
> "Before calling ANY tool, always first speak a brief acknowledgement out loud..."

This ensures TTS starts playing (~1–2s for first tokens) while the tool executes in the background, overlapping network I/O with audio playback. The LLM emits text, then tool_calls in the same streaming response. The `finish_reason: tool_calls` handler waits for both the text to stream and the tool to complete before the next LLM iteration.

---

## Knowledge Module

The `knowledge/` module is a standalone npm package with two exports:

- `searchKnowledge(query, options?)` — vector search, returns a context string or `null`
- `src/ingest/index.js` — CLI for ingesting files and websites

### LanceDB

LanceDB is an embedded columnar vector database (Rust-backed, no server process). The database lives on disk at `knowledge/db/` and is opened as a module-level singleton in `search.js`.

Query flow:
```
searchKnowledge(query)
 │
 ├── embed query → OpenAI text-embedding-3-small (1536 dims)
 ├── LanceDB cosine similarity search → top-3 chunks
 ├── filter by _distance threshold (MAX_DISTANCE = 0.8)
 └── return formatted context block | null
```

### Ingest pipeline

```
Sources
 │
 ├── txt loader → reads plain text files
 ├── csv loader → one chunk per row, columns joined as "Key: Value | ..."
 └── web crawler → axios + cheerio, respects robots.txt, BFS up to 50 pages
 │
 ├── chunker → paragraph-first, 400-char chunks, 80-char overlap
 ├── embedder → OpenAI text-embedding-3-small, batched
 └── store → LanceDB write (or reset + write)
```

---

## Identity Model

Twilio Client calls arrive with `from` as `client:user@example.com` or `client:+5511999999999`. The `client:` prefix is an SDK artifact — backend services expect the raw identity.

`normalizeIdentity(from)` strips the prefix. It is applied:
- In all pre-fetch calls
- In `executeTool` for `userIdentity`, `userId`, and `email` parameters
- In the identity system message injected into every LLM call

The LLM is told the customer's raw identity and instructed to use it as `userIdentity` in tool calls. The executor normalises again as a safety net.

---

## Latency Stack

End-to-end latency from utterance end to first TTS audio:

```
Twilio STT finishes → prompt arrives at server (~0ms, network)
 → silence guard + mini LLM start (~1ms)
 → pre-fetch Promise.all resolves (already settled from setup)
 → RAG search (≤150ms, or null)
 → OpenAI stream starts (TTFB: model-dependent)
 → first text token received (TTFT)
 → first token sent to Twilio TTS
 → Twilio TTS synthesises + plays (~300–500ms)
```

The dominant variable is OpenAI TTFT, which depends heavily on model:
- `gpt-4o` — ~1–2s TTFT (recommended for voice)
- `gpt-4o-mini` — ~0.5–1.5s TTFT (for lowest latency, reduced quality)
- o-series (`o3-mini`, `o4-mini`) — ~7–9s TTFT (reasoning overhead — not ideal for voice)

---

## Logging

All log I/O is decoupled from the SPI critical path using an async queue drained via `setImmediate`. Logging never blocks WebSocket message parsing, LLM streaming, or tool execution.

Log format:
```
[ISO timestamp] i info message
[ISO timestamp] ← RECV | type: prompt
[ISO timestamp] → SEND | type: text (streamed)
[ISO timestamp] * tool call | get_banking_data
[ISO timestamp] * tool result | get_banking_data (320ms) → ...
[ISO timestamp] ! warning
[ISO timestamp] x error
```

LLM timing is logged at four points per iteration:
- `LLM → request` — just before the OpenAI call
- `LLM ← stream ready` — time to first byte (TTFB)
- `LLM ← first token` — time to first text token (TTFT)
- `LLM ← done` — total streaming duration, finish reason, response length, cache hits

---

## Security Notes

- `.env` is gitignored — never committed
- `db/` (LanceDB data) is gitignored — rebuilt locally from source files
- Twilio Function endpoints are the only external write surfaces — authenticated by Twilio's own account context
- Twilio Sync and Segment API calls use Basic auth over HTTPS — credentials from environment only
