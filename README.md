# Twilio Sample AI Agents

Multi-channel AI agent samples built on Twilio Conversation Relay and OpenAI.

Each channel runs as an isolated service to avoid cross-channel latency interference. Voice is the foundation — other channels build on the same patterns.

---

## Channels

| Channel | Status | Docs |
|---------|--------|------|
| Voice | Active | [voice/VOICE-AGENT.md](voice/VOICE-AGENT.md) |
| Messaging | Planned | — |
| Email | Planned | — |
| Video | Planned | — |

---

## Architecture

```
Caller
  │  PSTN / SIP / Twilio Client
  ▼
Twilio Voice  ──  TwiML ConversationRelay
  │
  │  WebSocket (SPI messages)
  ▼
voice/server.js  (localhost:8080)
  │
  ├── onSetup (concurrent pre-fetches)
  │     ├── fetchConversationsContext()  ──►  Twilio Conversations API
  │     ├── fetchSegmentProfile()        ──►  Segment Profiles API
  │     └── fetchBankingData()           ──►  Twilio Sync (direct)
  │
  ├── onPrompt
  │     ├── searchKnowledge()            ──►  LanceDB (knowledge/db/)
  │     ├── await all pre-fetches
  │     ├── build system messages
  │     └── OpenAI gpt-4o (streaming + tool calls)
  │           ├── text tokens            ──►  Twilio TTS  ──►  Caller
  │           └── tool calls             ──►  APIs / Twilio Functions
  │                 get_banking_data
  │                 get_investment_data
  │                 get_customer_profile
  │                 get_last_segment_events
  │                 get_stocks_data
  │                 invest_money
  │                 studio_handover  ──►  end SPI message
  │                 flex_handover    ──►  end SPI message
  │
  └── ngrok tunnel (your-domain.ngrok.io → localhost:8080)
```

Each channel is a standalone Node.js process — no shared runtime, no shared port.

---

## Modules

### `voice/`
WebSocket server for Twilio Conversation Relay. Handles the full SPI message loop, streams LLM responses back as TTS tokens, executes OpenAI function/tool calls directly against Twilio and third-party APIs, and queries the knowledge base on every turn.

Key files:
- `server.js` — WebSocket server, session management, prompt handling loop
- `tools.js` — OpenAI tool definitions, identity normalisation, tool executor, proactive pre-fetch helpers

### `knowledge/`
Shared RAG module used by all channels. Provides:
- `searchKnowledge(query)` — vector similarity search, returns context for injection into LLM prompts
- Ingest CLI — crawl websites, ingest `.txt` and `.csv` files, embed and store in LanceDB

---

## Stack

- **Runtime** — Node.js 20+ (ESM)
- **Voice** — Twilio Conversation Relay via WebSocket (`ws`)
- **LLM** — OpenAI `gpt-4o` (streaming chat completions with tool calls)
- **Embeddings** — OpenAI `text-embedding-3-small`
- **Vector DB** — LanceDB (embedded, no server required)
- **Data** — Twilio Sync (per-user data), Twilio Conversations (interaction history)
- **Profiles** — Segment Profiles API (customer traits and events)
- **Tunnel** — ngrok custom domain

---

## Environment

All channels share the same `.env` structure. See [voice/.env.example](voice/.env.example) for the full template.

Key variables:

```
TWILIO_ACCOUNT_SID
TWILIO_AUTH_TOKEN
OPENAI_API_KEY
OPENAI_MODEL=gpt-4o
NGROK_DOMAIN
NGROK_AUTHTOKEN
STUDIO_HANDOVER_URL    # optional — Twilio Function for studio_handover tool
FLEX_HANDOVER_URL      # optional — Twilio Function for flex_handover tool
SEGMENT_SPACE_ID       # optional
SEGMENT_ACCESS_SECRET  # optional
PORT=8080
```

Optional variables are null-safe — the agent degrades gracefully if they are not set.

---

## Quick Start

```bash
# Clone and configure
git clone https://github.com/fvmach/twilio-sample-ai-agents.git
cd twilio-sample-ai-agents

# Option A — interactive quickstart script
bash scripts/quickstart.sh

# Option B — manual setup
cd voice
cp .env.example .env
# Edit .env with your credentials, then:
npm install
npm start
```

Point your TwiML Bin to the printed `wss://` URL. The voice server works before knowledge ingestion — RAG is skipped silently until the database exists. All pre-fetches (Segment, Sync, Conversations) are also null-safe.

See [docs/setup.md](docs/setup.md) for the full end-to-end setup guide.

---

## Docs

- [docs/setup.md](docs/setup.md) — End-to-end setup from scratch
- [docs/architecture.md](docs/architecture.md) — Architecture deep dive
- [voice/VOICE-AGENT.md](voice/VOICE-AGENT.md) — Voice channel reference
- [knowledge/KNOWLEDGE.md](knowledge/KNOWLEDGE.md) — RAG module reference
