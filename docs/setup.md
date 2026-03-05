# Setup Guide

End-to-end guide for running the voice agent from scratch.

---

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| Node.js 20+ | `node --version` to check |
| Twilio account | [console.twilio.com](https://console.twilio.com) |
| Twilio phone number | Must have Voice capability |
| OpenAI API key | [platform.openai.com](https://platform.openai.com) |
| ngrok account | [dashboard.ngrok.com](https://dashboard.ngrok.com) — free plan works |
| ngrok reserved domain | Under **Cloud Edge → Domains** — free one included |

Segment, Twilio Sync, and the handover tools are optional. The agent works without them — profile, event, banking context, and handovers are silently skipped or gracefully degraded.

---

## 1. Clone and configure

```bash
git clone https://github.com/fvmach/twilio-sample-ai-agents.git
cd twilio-sample-ai-agents
```

```bash
cd voice
cp .env.example .env
```

Edit `.env`:

```bash
TWILIO_ACCOUNT_SID=ACxxxxxxxx...
TWILIO_AUTH_TOKEN=xxxxxxxx...
OPENAI_API_KEY=sk-proj-xxxxxxxx...
OPENAI_MODEL=gpt-4o          # gpt-4o recommended for lowest voice latency
NGROK_DOMAIN=your-domain.ngrok.io
NGROK_AUTHTOKEN=xxxxxxxx...

# Twilio Sync — stores per-user data (account balance, investments, etc.)
# Find at console.twilio.com → Sync → Services
SYNC_SERVICE_SID=ISxxxxxxxx...

# Alpha Vantage — for get_stocks_data tool (free key at alphavantage.co)
ALPHA_VANTAGE_API_KEY=xxxxxxxx...

# Segment — optional, for customer profile and event context
SEGMENT_SPACE_ID=xxxxxxxx...
SEGMENT_ACCESS_SECRET=xxxxxxxx...

# Handover tools — optional Twilio Function URLs
STUDIO_HANDOVER_URL=https://your-functions-domain.twil.io/tools/studio-handover
FLEX_HANDOVER_URL=https://your-functions-domain.twil.io/tools/flex-handover
```

---

## 2. Customise the agent

Before running, open `voice/server.js` and edit `SYSTEM_PROMPT` to describe your agent's persona, company, and rules. The default is a minimal starter template.

Also review `voice/tools.js`:
- Update `INVESTMENT_PRODUCTS` to match your product catalog (or remove `invest_money` from `TOOLS` if not needed)
- Remove tools you don't need from the `TOOLS` array to keep the prompt focused

---

## 3. Install dependencies

```bash
# Voice server
cd voice
npm install

# Knowledge module (only needed for RAG ingestion)
cd ../knowledge
npm install
```

---

## 4. (Optional) Seed the knowledge base

If you have knowledge files, ingest them before starting the server:

```bash
cd knowledge

# Ingest the sample knowledge files from knowledge/files/ and knowledge/sources/
node src/ingest/index.js --source files --reset

# Or ingest a public website
node src/ingest/index.js --source web --url https://your-site.com

# Or both
node src/ingest/index.js --source all --url https://your-site.com --reset
```

The database is created at `knowledge/db/`. The voice server degrades gracefully if this directory does not exist — RAG is silently skipped.

---

## 5. Start the voice server

```bash
cd voice
npm start
```

Expected output:

```
ConversationRelay Voice Server
   Local:  ws://localhost:8080
   Model:  gpt-4o
   Public: wss://your-domain.ngrok.io

   TwiML ConversationRelay URL:
   wss://your-domain.ngrok.io
```

The server starts ngrok automatically if `NGROK_DOMAIN` and `NGROK_AUTHTOKEN` are set. If ngrok fails, run it manually:

```bash
ngrok http --domain=your-domain.ngrok.io 8080
```

---

## 6. Configure TwiML

Create a TwiML Bin in the [Twilio Console](https://console.twilio.com) → **TwiML Bins**:

```xml
<Response>
  <Connect>
    <ConversationRelay
      url="wss://your-domain.ngrok.io"
      welcomeGreeting="Hello, how can I help you today?"
    />
  </Connect>
</Response>
```

Under your phone number (**Phone Numbers → Manage → Active numbers**), set:

- **A call comes in** → TwiML Bin → select the bin above

---

## 7. Test the setup

Call your Twilio phone number. You should hear the welcome greeting and be able to have a conversation with the agent.

To watch the conversation in real-time, keep the server terminal open — all SPI messages, tool calls, LLM timing, and prompt cache hits are logged.

---

## Customising the agent

| What | Where |
|------|-------|
| Agent persona and rules | `voice/server.js` → `SYSTEM_PROMPT` |
| Available tools | `voice/tools.js` → `TOOLS` array |
| Tool implementations | `voice/tools.js` → `exec*` functions |
| Investment product catalog | `voice/tools.js` → `INVESTMENT_PRODUCTS` |
| Long-wait interstitial phrases | `voice/server.js` → `LONG_WAIT_PHRASES` |
| Knowledge sources | `knowledge/files/` and `knowledge/sources/` |
| LLM model | `OPENAI_MODEL` in `.env` |

---

## Troubleshooting

**No audio / call drops immediately**
- Check that the TwiML Bin URL matches the printed `wss://` URL exactly
- Verify ngrok is running and the tunnel is active

**LLM not responding**
- Check `OPENAI_API_KEY` is set and valid
- Look for error logs starting with `x` in the server terminal

**Very high latency (7–9s TTFT)**
- Set `OPENAI_MODEL=gpt-4o` in `.env` — o-series models have inherent reasoning overhead that is not suitable for voice

**Segment / banking data missing**
- These are optional — the agent works without them
- If set, verify `SEGMENT_SPACE_ID` and `SEGMENT_ACCESS_SECRET` are correct
- Verify `SYNC_SERVICE_SID` points to an active Sync service

**RAG returning no results**
- Run the ingest step first: `node src/ingest/index.js --source files --reset`
- Check `knowledge/db/` exists after ingestion

**Conversations context always null**
- Check `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` are set and valid
- Verify the caller identity exists as a Conversations participant in your account

**Handover tools not working**
- Set `STUDIO_HANDOVER_URL` and/or `FLEX_HANDOVER_URL` in `.env`
- These must point to valid Twilio Function URLs in your account
