#!/usr/bin/env bash
# quickstart.sh — interactive setup for the ConversationRelay voice agent
# Usage: bash scripts/quickstart.sh

set -e

BOLD="\033[1m"
GREEN="\033[32m"
YELLOW="\033[33m"
CYAN="\033[36m"
DIM="\033[2m"
RESET="\033[0m"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VOICE_DIR="$REPO_ROOT/voice"
KNOWLEDGE_DIR="$REPO_ROOT/knowledge"
ENV_FILE="$VOICE_DIR/.env"
ENV_EXAMPLE="$VOICE_DIR/.env.example"

info()    { echo -e "${CYAN}→${RESET} $1"; }
success() { echo -e "${GREEN}✓${RESET} $1"; }
warn()    { echo -e "${YELLOW}!${RESET} $1"; }
header()  { echo -e "\n${BOLD}$1${RESET}\n"; }
prompt()  { echo -en "${BOLD}$1${RESET} "; }

header "ConversationRelay Voice Agent — Quickstart"

# ── Prerequisite checks ──────────────────────────────────────────────────────

header "Checking prerequisites..."

if ! command -v node &>/dev/null; then
  echo "Node.js is not installed. Install from https://nodejs.org (version 20+)"
  exit 1
fi

NODE_VERSION=$(node --version | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
  warn "Node.js version is $NODE_VERSION. Version 20+ is required."
  exit 1
fi
success "Node.js $(node --version)"

if ! command -v npm &>/dev/null; then
  echo "npm is not installed."
  exit 1
fi
success "npm $(npm --version)"

# ── .env setup ───────────────────────────────────────────────────────────────

header "Environment configuration"

if [ -f "$ENV_FILE" ]; then
  warn ".env already exists at voice/.env"
  prompt "Overwrite it? [y/N]:"
  read -r overwrite
  if [[ ! "$overwrite" =~ ^[Yy]$ ]]; then
    info "Keeping existing .env"
  else
    cp "$ENV_EXAMPLE" "$ENV_FILE"
    success "Copied .env.example → voice/.env"
  fi
else
  cp "$ENV_EXAMPLE" "$ENV_FILE"
  success "Copied .env.example → voice/.env"
fi

echo ""
info "Now fill in your credentials in voice/.env"
echo -e "   ${DIM}Required:${RESET}"
echo -e "   ${DIM}  TWILIO_ACCOUNT_SID  — from console.twilio.com${RESET}"
echo -e "   ${DIM}  TWILIO_AUTH_TOKEN   — from console.twilio.com${RESET}"
echo -e "   ${DIM}  OPENAI_API_KEY      — from platform.openai.com${RESET}"
echo -e "   ${DIM}  NGROK_DOMAIN        — your reserved ngrok domain (dashboard.ngrok.com)${RESET}"
echo -e "   ${DIM}  NGROK_AUTHTOKEN     — from dashboard.ngrok.com${RESET}"
echo ""
echo -e "   ${DIM}Optional:${RESET}"
echo -e "   ${DIM}  SYNC_SERVICE_SID    — Twilio Sync for per-user data${RESET}"
echo -e "   ${DIM}  SEGMENT_SPACE_ID / SEGMENT_ACCESS_SECRET — customer profiles${RESET}"
echo -e "   ${DIM}  ALPHA_VANTAGE_API_KEY — stock data (alphavantage.co)${RESET}"
echo -e "   ${DIM}  STUDIO_HANDOVER_URL / FLEX_HANDOVER_URL — Twilio Function URLs${RESET}"
echo ""

prompt "Open voice/.env in your editor now? [Y/n]:"
read -r open_editor
if [[ ! "$open_editor" =~ ^[Nn]$ ]]; then
  if command -v code &>/dev/null; then
    code "$ENV_FILE"
  elif [ -n "$EDITOR" ]; then
    $EDITOR "$ENV_FILE"
  else
    open "$ENV_FILE" 2>/dev/null || vi "$ENV_FILE"
  fi
  echo ""
  prompt "Press Enter when you have finished editing .env..."
  read -r
fi

# ── Install dependencies ─────────────────────────────────────────────────────

header "Installing dependencies..."

info "Installing voice server dependencies..."
(cd "$VOICE_DIR" && npm install --silent)
success "voice/ dependencies installed"

info "Installing knowledge module dependencies..."
(cd "$KNOWLEDGE_DIR" && npm install --silent)
success "knowledge/ dependencies installed"

# ── Knowledge ingestion ──────────────────────────────────────────────────────

header "Knowledge base (RAG)"

echo "The knowledge base is optional. The voice server works without it — RAG is"
echo "silently skipped until the database is seeded."
echo ""
echo "Sample files are provided in:"
echo -e "   ${DIM}knowledge/files/   — plain text files${RESET}"
echo -e "   ${DIM}knowledge/sources/ — CSV files${RESET}"
echo ""

prompt "Seed the knowledge base now with the sample files? [Y/n]:"
read -r seed_kb

if [[ ! "$seed_kb" =~ ^[Nn]$ ]]; then
  info "Ingesting sample knowledge files..."
  (cd "$KNOWLEDGE_DIR" && node src/ingest/index.js --source files --reset)
  success "Knowledge base seeded"

  prompt "Also crawl a website? [y/N]:"
  read -r crawl_web
  if [[ "$crawl_web" =~ ^[Yy]$ ]]; then
    prompt "Enter the URL to crawl (e.g. https://your-site.com):"
    read -r crawl_url
    if [ -n "$crawl_url" ]; then
      info "Crawling $crawl_url..."
      (cd "$KNOWLEDGE_DIR" && node src/ingest/index.js --source web --url "$crawl_url")
      success "Website crawled and ingested"
    fi
  fi
else
  info "Skipping knowledge ingestion"
fi

# ── Summary ──────────────────────────────────────────────────────────────────

header "Setup complete!"

echo -e "Start the voice server:\n"
echo -e "   ${BOLD}cd voice && npm start${RESET}\n"
echo "The server will print a wss:// URL — use that in your TwiML Bin:"
echo ""
echo -e "   ${DIM}<Response>${RESET}"
echo -e "   ${DIM}  <Connect>${RESET}"
echo -e "   ${DIM}    <ConversationRelay${RESET}"
echo -e "   ${DIM}      url=\"wss://your-domain.ngrok.io\"${RESET}"
echo -e "   ${DIM}      welcomeGreeting=\"Hello, how can I help you today?\"${RESET}"
echo -e "   ${DIM}    />${RESET}"
echo -e "   ${DIM}  </Connect>${RESET}"
echo -e "   ${DIM}</Response>${RESET}"
echo ""
echo "Assign the TwiML Bin to your Twilio phone number and call it to test."
echo ""
echo -e "${DIM}See docs/setup.md for the full end-to-end guide.${RESET}"
echo ""
