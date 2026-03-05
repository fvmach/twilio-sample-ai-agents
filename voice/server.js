import 'dotenv/config';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import OpenAI from 'openai';
import ngrok from '@ngrok/ngrok';
import { searchKnowledge } from '../knowledge/src/search.js';
import { TOOLS, executeTool, normalizeIdentity, fetchConversationsContext, fetchSegmentProfile, fetchBankingData } from './tools.js';

// ─── Config ────────────────────────────────────────────────────────────────

const PORT         = parseInt(process.env.PORT || '8080');
const NGROK_DOMAIN = process.env.NGROK_DOMAIN;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5-mini';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─── Async log queue ───────────────────────────────────────────────────────

const _q = [];
let _draining = false;

function _drain() {
  if (_draining || _q.length === 0) return;
  _draining = true;
  setImmediate(() => {
    const lines = _q.splice(0, _q.length);
    for (const l of lines) process.stdout.write(l);
    _draining = false;
    if (_q.length > 0) _drain();
  });
}

function log(line) { _q.push(line + '\n'); _drain(); }

// ─── Log formatters ────────────────────────────────────────────────────────

const R = '\x1b[0m';
const D = '\x1b[2m';
const C = '\x1b[36m';
const Y = '\x1b[33m';
const RE = '\x1b[31m';
const G = '\x1b[32m';
const B = '\x1b[1m';

function ts() { return new Date().toISOString(); }

function logRecv(type, raw) {
  log(`\n${D}[${ts()}]${R} ${C}←${R} ${C}RECV${R} ${D}|${R} ${B}type: ${type}${R}\n${D}${raw}${R}`);
}

function logSend(type, payload) {
  log(`\n${D}[${ts()}]${R} ${Y}→${R} ${Y}SEND${R} ${D}|${R} ${B}type: ${type}${R}\n${D}${JSON.stringify(payload, null, 2)}${R}`);
}

function logTextTurn(text) {
  log(`\n${D}[${ts()}]${R} ${Y}→${R} ${Y}SEND${R} ${D}|${R} ${B}type: text (streamed)${R}\n${D}"${text}"${R}`);
}

function logToolCall(name, args) {
  log(`\n${D}[${ts()}]${R} ${G}*${R}  ${B}tool call${R} ${D}|${R} ${name}\n${D}${JSON.stringify(args, null, 2)}${R}`);
}

function logToolResult(name, result, durationMs) {
  const preview = JSON.stringify(result);
  const dur     = durationMs !== undefined ? ` ${D}(${durationMs}ms)${R}` : '';
  log(`${D}[${ts()}]${R} ${G}*${R}  ${B}tool result${R} ${D}|${R} ${name}${dur} ${D}→ ${preview.slice(0, 160)}${preview.length > 160 ? '…' : ''}${R}`);
}

function logInfo(msg)  { log(`${D}[${ts()}]${R} ${G}i${R}  ${msg}`); }
function logError(msg) { log(`${D}[${ts()}]${R} ${RE}x${R}  ${msg}`); }
function logWarn(msg)  { log(`${D}[${ts()}]${R} ${Y}!${R}  ${msg}`); }

// ─── System prompt ─────────────────────────────────────────────────────────

// ── Customise this prompt for your use case ────────────────────────────────
// Replace the persona, company name, and tool guidelines to match your agent.
const SYSTEM_PROMPT = `You are an AI voice assistant. You help customers in a warm and professional manner.

Guidelines for voice responses:
- Be concise — phone callers listen, they don't read. Target 20-40 words per reply.
- Use natural conversational language, as if speaking to someone on the phone
- Avoid markdown, special characters, bullet points, or emojis
- Spell out abbreviations (e.g. say "two factor authentication", not "2FA")
- Spell out numbers and currency amounts in full words
- Keep responses under 2 sentences for simple queries; up to 4 for complex ones
- If you don't know something, say so and offer to connect them with a specialist

Tool guidelines:
- CRITICAL: When calling a tool, stream a brief spoken acknowledgement (1 sentence) AND call the tool in THE SAME response — both must happen together in one completion. Never produce a text-only response that says you "will" do something and then wait for the user to speak again. The spoken text and the tool call must be simultaneous.
- If the customer asks to speak to a human, or if you cannot fulfill their request, use flex_handover
- For invest_money: confirm the product and amount ONCE. The moment the customer confirms ("yes", "sure", "go ahead", etc.), call invest_money immediately in the same response as your acknowledgement — do not ask for confirmation a second time.
- When discussing stocks or performing risk analysis, always remind the customer that they are solely responsible for buy and sell decisions
- Use the customer's phone number or email as their userIdentity in tool calls`;

// ─── Session ───────────────────────────────────────────────────────────────

class Session {
  constructor(callSid, from, to) {
    this.callSid                = callSid;
    this.from                   = from;
    this.to                     = to;
    this.history                = [];
    this.summary                = '';    // rolling transcript of compacted old turns
    this.hasMutated             = false; // true after any state-changing tool (invest, pix)
    this.abortController        = null;
    this.contextPromise         = null;
    this.profilePromise         = null;
    this.bankingPromise         = null;
    this.lastInterruptUtterance = null;  // what the caller said when interrupting
    this.lastLang               = 'pt-BR'; // most recent STT language tag
    this.createdAt              = Date.now();
  }

  addMessage(msg) {
    this.history.push(msg);
  }

  abort() {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }
}

const sessions = new Map();

// ─── Context compacting ────────────────────────────────────────────────────

const COMPACT_AFTER = 10; // compact when history exceeds this many messages
const COMPACT_KEEP  = 4;  // keep the most recent N messages intact (must start at a user msg)

const MUTATION_TOOLS = new Set(['invest_money']);

// Matches first-person future-action promises that should have triggered a tool call.
// Used to detect when the LLM says it will do something but doesn't call the tool.
const DEFERRED_ACTION_RE = /\bi('ll| will) (check|look|find|transfer|invest|apply|process|execute|look up|pull up)\b/i;

function compactHistory(messages) {
  const lines = ['Earlier in this call:'];
  for (const m of messages) {
    if (m.role === 'user') {
      lines.push(`User: ${m.content}`);
    } else if (m.role === 'assistant') {
      if (m.tool_calls?.length) {
        const names = m.tool_calls.map(tc => tc.function.name).join(', ');
        lines.push(`[Tools called: ${names}]`);
      }
      if (m.content) lines.push(`Assistant: ${m.content}`);
    }
  }
  return lines.join('\n');
}

function maybeCompact(session) {
  if (session.history.length < COMPACT_AFTER) return;

  // Find the split point: keep the last COMPACT_KEEP messages, but walk back
  // to a user-message boundary so tool_call/tool pairs always stay together.
  let keepFrom = session.history.length - COMPACT_KEEP;
  while (keepFrom > 0 && session.history[keepFrom].role !== 'user') keepFrom--;

  if (keepFrom <= 0) return;

  const toCompact = session.history.slice(0, keepFrom);
  const chunk     = compactHistory(toCompact);
  session.summary = session.summary ? `${session.summary}\n\n${chunk}` : chunk;
  session.history = session.history.slice(keepFrom);

  logInfo(`History compacted | ${toCompact.length} msgs → summary | ${session.history.length} kept`);
}

// ─── Send helpers ──────────────────────────────────────────────────────────

function sendText(ws, token, last, extra = {}) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify({ type: 'text', token, last, interruptible: true, ...extra }));
}

function sendLogged(ws, message) {
  if (ws.readyState !== ws.OPEN) return;
  setImmediate(() => logSend(message.type, message));
  ws.send(JSON.stringify(message));
}

function sendEnd(ws, handoffData = '') {
  sendLogged(ws, { type: 'end', handoffData });
}

// ─── Interstitial phrases ──────────────────────────────────────────────────

const INTERSTITIAL_MODEL = 'gpt-4o-mini';

// Long-wait phrase (15s) — empathetic, longer
const LONG_WAIT_PHRASES = {
  pt: 'Essa consulta está levando um pouco mais do que o esperado — já já te retorno!',
  en: "This is taking a bit longer than expected, but I'll have an answer for you very shortly.",
  es: 'Esto está tardando un poco más de lo esperado, pero ya casi tengo tu respuesta.',
};

function getLongWaitPhrase(lang) {
  const prefix = (lang || 'pt-BR').split('-')[0].toLowerCase();
  return LONG_WAIT_PHRASES[prefix] || LONG_WAIT_PHRASES.pt;
}

// ─── Message handlers ──────────────────────────────────────────────────────

function onSetup(ws, message) {
  const session = new Session(message.callSid, message.from, message.to);
  const t = Date.now();

  session.contextPromise = fetchConversationsContext(session.from);
  session.profilePromise = fetchSegmentProfile(session.from);
  session.bankingPromise = fetchBankingData(session.from);

  const logFetch = (label, p) => p
    .then(r  => logInfo(`Pre-fetch | ${label} | ${Date.now() - t}ms | ${r ? 'ok' : 'null'}`))
    .catch(() => logInfo(`Pre-fetch | ${label} | ${Date.now() - t}ms | error`));

  logFetch('conversations',  session.contextPromise);
  logFetch('segment-profile', session.profilePromise);
  logFetch('banking-data',    session.bankingPromise);

  sessions.set(ws, session);
  logInfo(`Session started | callSid: ${message.callSid} | ${message.from} -> ${message.to}`);
}

async function onPrompt(ws, message) {
  const session = sessions.get(ws);
  if (!session) { logWarn('Prompt received but no session found'); return; }

  const userText = message.voicePrompt?.trim();
  if (!userText) { logWarn('Empty voicePrompt, skipping'); return; }

  session.lastLang = message.lang || session.lastLang;

  session.abort();
  session.addMessage({ role: 'user', content: userText });
  const ctrl = new AbortController();
  session.abortController = ctrl;

  let _sgSignal        = null;
  let _sgTimers        = [];
  let _interstitialCtrl = null;

  function stopSilenceGuard() {
    if (_sgSignal) _sgSignal.cancelled = true;
    _sgTimers.forEach(clearTimeout);
    _sgTimers        = [];
    _sgSignal        = null;
    if (_interstitialCtrl) { _interstitialCtrl.abort(); _interstitialCtrl = null; }
  }

  function startSilenceGuard() {
    stopSilenceGuard();
    const signal = { cancelled: false };
    _sgSignal    = signal;

    // Fire mini LLM immediately — result is ready well before the 5s timer fires
    _interstitialCtrl = new AbortController();
    let interstitialText = null;
    const langName = session.lastLang.startsWith('en') ? 'English'
      : session.lastLang.startsWith('es') ? 'Spanish'
      : 'Brazilian Portuguese';

    openai.chat.completions.create({
      model:       INTERSTITIAL_MODEL,
      max_tokens:  20,
      temperature: 0.9,
      messages: [
        { role: 'system', content: `Generate ONE short filler phrase (5-8 words) in ${langName} for a voice assistant waiting on a lookup. TTS-safe, conversational, no special characters.` },
        { role: 'user',   content: userText },
      ],
      stream: false,
    }, { signal: _interstitialCtrl.signal })
      .then(r => { interstitialText = r.choices[0]?.message?.content?.trim() || null; })
      .catch(() => {});

    // 5s: send LLM-generated phrase (or short fallback if not ready)
    _sgTimers.push(setTimeout(() => {
      if (signal.cancelled || ws.readyState !== ws.OPEN) return;
      const text = interstitialText || 'Só um instante...';
      sendText(ws, text, true, { preemptible: true });
      setImmediate(() => logInfo(`Interstitial (5s) | "${text}"`));
    }, 5000));

    // 15s: empathetic long-wait phrase
    _sgTimers.push(setTimeout(() => {
      if (signal.cancelled || ws.readyState !== ws.OPEN) return;
      const text = getLongWaitPhrase(session.lastLang);
      sendText(ws, text, true, { preemptible: true });
      setImmediate(() => logInfo(`Interstitial (15s) | "${text}"`));
    }, 15000));
  }

  startSilenceGuard();

  const [ragContext, conversationsContext, segmentProfile, bankingData] = await Promise.all([
    Promise.race([
      searchKnowledge(userText),
      new Promise(r => setTimeout(() => r(null), 150)),
    ]),
    session.contextPromise,
    session.profilePromise,
    session.bankingPromise,
  ]);

  // ── System messages ordered for maximum prompt-cache prefix stability ──────
  // Static/session-stable content comes FIRST (cached across turns).
  // Per-turn dynamic content (interrupt, RAG) comes LAST (not cached).
  // OpenAI caches the longest matching prefix in 128-token blocks (≥1024 tokens).
  const systemMessages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'system', content: `Customer identity: ${normalizeIdentity(session.from)}. Use this as the userIdentity parameter in all tool calls.` },
  ];

  // Session-stable context (changes at most once per session) — cache-friendly
  if (segmentProfile)      systemMessages.push({ role: 'system', content: `Customer profile: ${JSON.stringify(segmentProfile)}` });
  if (bankingData) {
    const trimmed = { ...bankingData, transactions: (bankingData.transactions ?? []).slice(0, 5) };
    systemMessages.push({ role: 'system', content: `Customer banking data (already loaded — do NOT call get_banking_data): ${JSON.stringify(trimmed)}` });
  }
  if (conversationsContext) systemMessages.push({ role: 'system', content: `Customer's past interaction history: ${JSON.stringify(conversationsContext)}` });
  if (session.summary)      systemMessages.push({ role: 'system', content: session.summary });

  // Per-turn dynamic content — always at the end to avoid invalidating the cache prefix
  if (session.lastInterruptUtterance) {
    systemMessages.push({ role: 'system', content: `The customer interrupted your previous response by saying: "${session.lastInterruptUtterance}". Acknowledge this naturally at the start of your reply.` });
    session.lastInterruptUtterance = null;
  }
  if (ragContext) systemMessages.push({ role: 'system', content: ragContext });

  const MAX_TOOL_ITER    = 10;
  let iter               = 0;
  let endCall            = false;
  let prevIterHadText    = true; // iter 1 guard is already running
  let _deferredNudge     = false; // true after we inject a deferred-action nudge

  try {
    while (iter < MAX_TOOL_ITER) {
      iter++;
      // Restart the silence guard only when the previous iteration produced no text.
      // If the LLM spoke, TTS is still playing — starting a new guard would overlap with the audio.
      if (iter > 1 && !prevIterHadText) startSilenceGuard();

      // Re-enable get_banking_data after mutations so the LLM can fetch a fresh balance.
      const activeTools = TOOLS.filter(({ function: { name } }) => {
        if (name === 'get_banking_data'        && bankingData && !session.hasMutated) return false;
        if (name === 'get_customer_profile'    && segmentProfile)                    return false;
        if (name === 'get_last_segment_events' && conversationsContext)              return false;
        return true;
      });

      // Start from the first user message to keep tool_call/tool pairs intact.
      let historyForLLM = session.history;
      const firstUser   = historyForLLM.findIndex(m => m.role === 'user');
      if (firstUser > 0) historyForLLM = historyForLLM.slice(firstUser);

      const llmStart = Date.now();
      logInfo(`LLM → request | iter ${iter} | ${systemMessages.length + historyForLLM.length} messages | ${activeTools.length} tools`);

      const stream = await openai.chat.completions.create(
        {
          model:                 OPENAI_MODEL,
          messages:              [...systemMessages, ...historyForLLM],
          tools:                 activeTools,
          tool_choice:           _deferredNudge ? 'required' : 'auto',
          parallel_tool_calls:   true,
          max_completion_tokens: 400,   // voice responses are short; cap signals expected length to API
          stream:                true,
          stream_options:        { include_usage: true },
        },
        { signal: ctrl.signal }
      );

      logInfo(`LLM ← stream ready | ${Date.now() - llmStart}ms`);

      let fullResponse = '';
      let firstFlushed = false;
      const toolCalls  = {};
      let finishReason = null;
      let usage        = null;

      for await (const chunk of stream) {
        // stream_options: include_usage sends a final chunk with no choices
        if (chunk.usage) { usage = chunk.usage; continue; }

        const choice = chunk.choices[0];
        if (!choice) continue;

        if (choice.finish_reason) finishReason = choice.finish_reason;

        const delta = choice.delta ?? {};

        const token = delta.content ?? '';
        if (token) {
          fullResponse += token;
          if (!firstFlushed) {
            logInfo(`LLM ← first token | ${Date.now() - llmStart}ms TTFT`);
            stopSilenceGuard(); // first word out — no more interstitials this turn
            firstFlushed = true;
          }
          sendText(ws, token, false);
        }

        for (const tc of (delta.tool_calls ?? [])) {
          if (!toolCalls[tc.index]) {
            toolCalls[tc.index] = { id: '', type: 'function', function: { name: '', arguments: '' } };
          }
          if (tc.id)                  toolCalls[tc.index].id                  = tc.id;
          if (tc.function?.name)      toolCalls[tc.index].function.name      += tc.function.name;
          if (tc.function?.arguments) toolCalls[tc.index].function.arguments += tc.function.arguments;
        }
      }

      const cachedTokens = usage?.prompt_tokens_details?.cached_tokens ?? 0;
      const cacheNote    = cachedTokens > 0 ? ` | cache: ${cachedTokens} tokens` : '';
      logInfo(`LLM ← done | ${Date.now() - llmStart}ms total | finish: ${finishReason} | ${fullResponse.length} chars${cacheNote}`);

      if (finishReason === 'tool_calls') {
        const toolCallsArray = Object.entries(toolCalls)
          .sort(([a], [b]) => Number(a) - Number(b))
          .map(([, tc]) => tc);

        session.addMessage({
          role:       'assistant',
          content:    fullResponse || null,
          tool_calls: toolCallsArray.map(tc => ({
            id:       tc.id,
            type:     tc.type,
            function: { name: tc.function.name, arguments: tc.function.arguments },
          })),
        });

        prevIterHadText = fullResponse.length > 0;
        if (fullResponse) setImmediate(() => logTextTurn(fullResponse));

        // Execute all tool calls concurrently — each one is independent
        const toolResults = await Promise.all(
          toolCallsArray.map(async (tc) => {
            let args;
            try { args = JSON.parse(tc.function.arguments); } catch { args = {}; }
            setImmediate(() => logToolCall(tc.function.name, args));
            const toolStart = Date.now();
            const result    = await executeTool(tc.function.name, args);
            const toolMs    = Date.now() - toolStart;
            setImmediate(() => logToolResult(tc.function.name, result, toolMs));
            return { tc, result };
          })
        );

        for (const { tc, result } of toolResults) {
          session.addMessage({
            role:         'tool',
            tool_call_id: tc.id,
            content:      JSON.stringify(result),
          });
          if (MUTATION_TOOLS.has(tc.function.name) && result.success) {
            session.hasMutated = true;
            logInfo(`Mutation detected (${tc.function.name}) — get_banking_data re-enabled`);
          }
          if (result._endCall) endCall = true;
        }

        continue;
      }

      // Deferred-action safety net: LLM said "I will do X" but didn't call the tool.
      // Inject a one-time nudge and re-run with tool_choice: required.
      if (!_deferredNudge && fullResponse && DEFERRED_ACTION_RE.test(fullResponse)) {
        session.addMessage({ role: 'assistant', content: fullResponse });
        systemMessages.push({ role: 'system', content: 'You acknowledged the customer\'s request but did not call any tool. Execute the action now by calling the appropriate tool — do not speak, just call the tool.' });
        _deferredNudge  = true;
        prevIterHadText = true; // LLM spoke; avoid overlapping interstitial
        logWarn(`Deferred action detected — forcing tool call | "${fullResponse.slice(0, 80)}"`);
        continue;
      }

      stopSilenceGuard();
      sendText(ws, '', true); // end-of-utterance marker

      setImmediate(() => logTextTurn(fullResponse));
      session.addMessage({ role: 'assistant', content: fullResponse });
      maybeCompact(session);
      break;
    }

    session.abortController = null;
    if (endCall) sendEnd(ws);

  } catch (err) {
    stopSilenceGuard();
    // OpenAI SDK throws APIUserAbortError ("Request was aborted.") not a standard AbortError
    const isAbort = err.name === 'AbortError' || err.message?.includes('aborted') || err.message?.includes('Request was aborted');
    if (isAbort) {
      logInfo('LLM stream aborted — caller interrupted');
    } else {
      logError(`LLM error: ${err.message}`);
      sendText(ws, "I'm sorry, something went wrong. Please try again.", true);
    }
  }
}

function onInterrupt(ws, message) {
  const session = sessions.get(ws);
  if (!session) return;

  session.abort();
  session.lastInterruptUtterance = message.utteranceUntilInterrupt || null;

  setImmediate(() => logInfo(`Interrupt | spoken: "${message.utteranceUntilInterrupt}" | after ${message.durationUntilInterruptMs}ms`));
}

function onDtmf(_ws, message) {
  logInfo(`DTMF | digit: ${message.digit}`);
}

function onError(_ws, message) {
  logError(`Twilio error: ${message.description}`);
}

// ─── Router ────────────────────────────────────────────────────────────────

async function routeMessage(ws, raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    logError(`Failed to parse message: ${raw}`);
    return;
  }

  const type = message.type ?? 'unknown';

  // 'info' messages are high-frequency diagnostics — silently discarded.
  if (type === 'info') return;

  setImmediate(() => logRecv(type, raw));

  switch (type) {
    case 'setup':     onSetup(ws, message);        break;
    case 'prompt':    await onPrompt(ws, message); break;
    case 'interrupt': onInterrupt(ws, message);    break;
    case 'dtmf':      onDtmf(ws, message);         break;
    case 'error':     onError(ws, message);        break;
    default:          logWarn(`Unhandled type: ${type}`);
  }
}

// ─── WebSocket server ──────────────────────────────────────────────────────

const httpServer = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('ConversationRelay WebSocket Server\n');
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws, req) => {
  logInfo(`WebSocket connected from ${req.socket.remoteAddress}`);

  ws.on('message', (data) => routeMessage(ws, data.toString()));

  ws.on('close', (code) => {
    const session = sessions.get(ws);
    if (session) {
      session.abort();
      const duration = Math.round((Date.now() - session.createdAt) / 1000);
      logInfo(`Session closed | callSid: ${session.callSid} | duration: ${duration}s | code: ${code}`);
    } else {
      logInfo(`WebSocket closed | code: ${code}`);
    }
    sessions.delete(ws);
  });

  ws.on('error', (err) => logError(`WebSocket error: ${err.message}`));
});

// ─── Startup ───────────────────────────────────────────────────────────────

httpServer.listen(PORT, async () => {
  process.stdout.write(`\n${B}ConversationRelay Voice Server${R}\n`);
  process.stdout.write(`   ${D}Local:${R}  ws://localhost:${PORT}\n`);
  process.stdout.write(`   ${D}Model:${R}  ${OPENAI_MODEL}\n`);

  if (NGROK_DOMAIN) {
    try {
      const listener  = await ngrok.connect({ addr: PORT, domain: NGROK_DOMAIN });
      const publicUrl = listener.url().replace('https://', 'wss://');
      process.stdout.write(`   ${D}Public:${R} ${publicUrl}\n`);
      process.stdout.write(`\n   ${B}TwiML ConversationRelay URL:${R}\n`);
      process.stdout.write(`   ${G}${publicUrl}${R}\n\n`);
    } catch (err) {
      process.stderr.write(`ngrok failed: ${err.message}\n`);
      process.stdout.write(`   Run ngrok manually: ngrok http --domain=${NGROK_DOMAIN} ${PORT}\n\n`);
    }
  } else {
    process.stdout.write(`\n   ${D}Tip: set NGROK_DOMAIN in .env to auto-connect ngrok${R}\n\n`);
  }
});
