// ─── Tool definitions (OpenAI function calling format) ─────────────────────

export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_banking_data',
      description: 'Get the customer\'s banking data including account balance, transactions, credit information, and loyalty points. Use this whenever the customer asks about their own account.',
      parameters: {
        type: 'object',
        properties: {
          userId: { type: 'string', description: 'The customer\'s email or phone number (their identity).' },
        },
        required: ['userId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_stocks_data',
      description: 'Get market data for a stock or ETF ticker. Supports time series prices, company overview, ETF profile, and news sentiment. Always remind the customer they are solely responsible for buy and sell decisions.',
      parameters: {
        type: 'object',
        properties: {
          ticker: { type: 'string', description: 'The stock or ETF ticker symbol, e.g. AAPL, MSFT, QQQ.' },
          request_type: {
            type: 'string',
            enum: ['stocks', 'news', 'company-info', 'etf'],
            description: 'Type of data to fetch. Default: stocks (daily time series).',
          },
        },
        required: ['ticker'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'invest_money',
      description: 'Make an investment on behalf of the customer. Always confirm the product and amount before calling. Validate against minimum investment amounts: smart_savings $10, income_shield $50, growth_fund $100, esg_select $100, crypto_access $200.',
      parameters: {
        type: 'object',
        properties: {
          userIdentity: { type: 'string', description: 'The customer\'s identity.' },
          amount:       { type: 'number', description: 'Amount to invest.' },
          productId: {
            type: 'string',
            enum: ['growth_fund', 'income_shield', 'crypto_access', 'esg_select', 'smart_savings'],
            description: 'The investment product ID.',
          },
        },
        required: ['userIdentity', 'amount', 'productId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'studio_handover',
      description: 'Use this to transfer the customer to a specific Studio flow (e.g. for status updates or specialised workflows).',
      parameters: {
        type: 'object',
        properties: {
          userIdentity: { type: 'string', description: 'The customer\'s identity.' },
        },
        required: ['userIdentity'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'flex_handover',
      description: 'Transfer the customer to a human agent. Use this if the customer explicitly asks to speak to a human or if you cannot fulfill their request.',
      parameters: {
        type: 'object',
        properties: {
          reason:       { type: 'string', description: 'Brief reason for the handover.' },
          userIdentity: { type: 'string', description: 'The customer\'s identity.' },
        },
        required: ['reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_investment_data',
      description: 'Get the customer\'s investment portfolio (current holdings, balances, risk levels) and the list of available investment products. Use when the customer asks about their investments or wants to see what products are available.',
      parameters: {
        type: 'object',
        properties: {
          userId: { type: 'string', description: 'The customer\'s email or phone number (their identity).' },
        },
        required: ['userId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_customer_profile',
      description: 'Fetch the customer\'s full profile from Segment including name, contact details, and custom traits. Use to get enriched profile data when you need information beyond what is already in context.',
      parameters: {
        type: 'object',
        properties: {
          email: { type: 'string', description: 'The customer\'s email address.' },
        },
        required: ['email'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_last_segment_events',
      description: 'Retrieve the customer\'s recent activity events from Segment (page views, product interactions, purchases). Use to understand what the customer was doing in the app before calling, to personalise the conversation.',
      parameters: {
        type: 'object',
        properties: {
          email: { type: 'string', description: 'The customer\'s email address.' },
        },
        required: ['email'],
      },
    },
  },
];

// ─── Config ─────────────────────────────────────────────────────────────────

const ACCOUNT_SID       = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN        = process.env.TWILIO_AUTH_TOKEN;
const SYNC_SERVICE_SID  = process.env.SYNC_SERVICE_SID;
const SEGMENT_SPACE_ID  = process.env.SEGMENT_SPACE_ID;
const SEGMENT_SECRET    = process.env.SEGMENT_ACCESS_SECRET;
const ALPHA_VANTAGE_KEY = process.env.ALPHA_VANTAGE_API_KEY;
const TWELVE_DATA_KEY   = process.env.TWELVE_DATA_API_KEY; // optional fallback

// ─── Investment product catalog ─────────────────────────────────────────────
// Customise these to match your actual investment products.

const INVESTMENT_PRODUCTS = {
  growth_fund:   { id: 'growth_fund',   name: 'Growth Fund',    riskLevel: 'medium',   minInvestment: 100 },
  income_shield: { id: 'income_shield',  name: 'Income Shield',  riskLevel: 'low',      minInvestment: 50  },
  crypto_access: { id: 'crypto_access',  name: 'Crypto Access',  riskLevel: 'high',     minInvestment: 200 },
  esg_select:    { id: 'esg_select',     name: 'ESG Select',     riskLevel: 'medium',   minInvestment: 100 },
  smart_savings: { id: 'smart_savings',  name: 'Smart Savings',  riskLevel: 'very_low', minInvestment: 10  },
};

// Default values for new / uninitialised accounts
const BANKING_DEFAULTS = {
  account_balance:    { balance: 10000, transactions: [] },
  credit_card:        { balance: 3500 },
  loyalty_points:     { balance: 42000 },
  investment_balance: { balance: 0, investments: [] },
};

// ─── Handover tools (Twilio Functions) ──────────────────────────────────────
// Set STUDIO_HANDOVER_URL and FLEX_HANDOVER_URL in .env to enable these tools.

const HANDOVER_ENDPOINTS = {
  studio_handover: process.env.STUDIO_HANDOVER_URL || '',
  flex_handover:   process.env.FLEX_HANDOVER_URL   || '',
};

const HANDOVER_TOOLS = new Set(['flex_handover', 'studio_handover']);

// ─── Identity normalization ─────────────────────────────────────────────────

export function normalizeIdentity(from) {
  return from.replace(/^client:/, '');
}

// Segment Profiles API expects "email:user@x.com" or "phone:+1..."
// Only the value part (after the prefix) is URL-encoded — the colon stays literal.
function segmentIdentifier(from) {
  const raw = normalizeIdentity(from);
  if (raw.includes('@')) return `email:${encodeURIComponent(raw)}`;
  return `phone:${encodeURIComponent(raw)}`;
}

// ─── Twilio Sync helpers ────────────────────────────────────────────────────

function syncAuth() {
  return Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString('base64');
}

function syncUrl(path) {
  return `https://sync.twilio.com/v1/Services/${SYNC_SERVICE_SID}${path}`;
}

async function syncGetItem(mapName, key) {
  const res = await fetch(
    syncUrl(`/Maps/${encodeURIComponent(mapName)}/Items/${encodeURIComponent(key)}`),
    { headers: { Authorization: `Basic ${syncAuth()}` } }
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Sync GET ${key}: ${res.status}`);
  return (await res.json()).data;
}

async function syncEnsureMap(mapName) {
  const check = await fetch(syncUrl(`/Maps/${encodeURIComponent(mapName)}`), {
    headers: { Authorization: `Basic ${syncAuth()}` },
  });
  if (check.ok) return;
  if (check.status !== 404) throw new Error(`Sync map check: ${check.status}`);
  const create = await fetch(syncUrl('/Maps'), {
    method:  'POST',
    headers: { Authorization: `Basic ${syncAuth()}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    `UniqueName=${encodeURIComponent(mapName)}`,
  });
  if (!create.ok && create.status !== 409) throw new Error(`Sync create map: ${create.status}`);
}

async function syncSetItem(mapName, key, data) {
  const headers = { Authorization: `Basic ${syncAuth()}`, 'Content-Type': 'application/x-www-form-urlencoded' };
  const encoded = `Data=${encodeURIComponent(JSON.stringify(data))}`;

  // Try update first (item already exists)
  const update = await fetch(
    syncUrl(`/Maps/${encodeURIComponent(mapName)}/Items/${encodeURIComponent(key)}`),
    { method: 'POST', headers, body: encoded }
  );
  if (update.ok) return (await update.json()).data;

  if (update.status !== 404) throw new Error(`Sync update ${key}: ${update.status}`);

  // Item not found — ensure map exists then create item
  await syncEnsureMap(mapName);
  const create = await fetch(syncUrl(`/Maps/${encodeURIComponent(mapName)}/Items`), {
    method:  'POST',
    headers,
    body:    `Key=${encodeURIComponent(key)}&${encoded}`,
  });
  if (!create.ok) throw new Error(`Sync create item ${key}: ${create.status}`);
  return (await create.json()).data;
}

// ─── Segment helpers ─────────────────────────────────────────────────────────

function segmentHeaders() {
  return {
    Authorization: `Basic ${Buffer.from(`${SEGMENT_SECRET}:`).toString('base64')}`,
    Accept: 'application/json',
  };
}

// ─── Proactive pre-fetches ──────────────────────────────────────────────────

export async function fetchConversationsContext(from) {
  if (!ACCOUNT_SID || !AUTH_TOKEN) return null;
  const identity = normalizeIdentity(from);
  const auth     = Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString('base64');
  const headers  = { Authorization: `Basic ${auth}` };

  try {
    // List the most recent conversations this identity participated in
    const listRes = await fetch(
      `https://conversations.twilio.com/v2/ParticipantConversations?Identity=${encodeURIComponent(identity)}&PageSize=5`,
      { headers, signal: AbortSignal.timeout(5000) }
    );
    if (!listRes.ok) return null;

    const participantConversations = (await listRes.json()).conversations ?? [];
    if (participantConversations.length === 0) return null;

    // Fetch messages for the top 3 conversations concurrently (not sequentially)
    const results = await Promise.all(
      participantConversations.slice(0, 3).map(async (pc) => {
        const sid = pc.conversation_sid;
        try {
          const msgsRes = await fetch(
            `https://conversations.twilio.com/v2/Conversations/${sid}/Messages?PageSize=15&Order=desc`,
            { headers, signal: AbortSignal.timeout(4000) }
          );
          if (!msgsRes.ok) return null;
          const messages = ((await msgsRes.json()).messages ?? []).reverse();
          return {
            conversationSid: sid,
            dateUpdated:     pc.conversation_date_updated,
            messages:        messages.map(m => ({ author: m.author, body: m.body, date: m.date_created })),
          };
        } catch {
          return null;
        }
      })
    );

    const valid = results.filter(Boolean);
    return valid.length > 0 ? valid : null;
  } catch {
    return null;
  }
}

export async function fetchSegmentProfile(from) {
  if (!SEGMENT_SPACE_ID || !SEGMENT_SECRET) return null;
  const identifier = segmentIdentifier(from);
  const url = `https://profiles.segment.com/v1/spaces/${SEGMENT_SPACE_ID}/collections/users/profiles/${identifier}/traits`;
  try {
    const res = await fetch(url, { headers: segmentHeaders() });
    if (!res.ok) {
      process.stderr.write(`[segment-profile] ${res.status} ${res.statusText}\n`);
      return null;
    }
    const data = await res.json();
    return data.traits ?? null;
  } catch (err) {
    process.stderr.write(`[segment-profile] fetch error: ${err.message}\n`);
    return null;
  }
}

export async function fetchBankingData(from) {
  if (!SYNC_SERVICE_SID) return null;
  const userId = normalizeIdentity(from);
  try {
    const [acctItem, creditItem, loyaltyItem, investItem] = await Promise.all([
      syncGetItem(userId, 'account_balance'),
      syncGetItem(userId, 'credit_card'),
      syncGetItem(userId, 'loyalty_points'),
      syncGetItem(userId, 'investment_balance'),
    ]);
    return {
      success:           true,
      balance:           (acctItem   ?? BANKING_DEFAULTS.account_balance).balance,
      transactions:      (acctItem   ?? BANKING_DEFAULTS.account_balance).transactions ?? [],
      creditDebt:        (creditItem ?? BANKING_DEFAULTS.credit_card).balance,
      loyaltyPoints:     (loyaltyItem ?? BANKING_DEFAULTS.loyalty_points).balance,
      investmentBalance: (investItem ?? BANKING_DEFAULTS.investment_balance).balance,
    };
  } catch {
    return null;
  }
}

// ─── Tool executor ─────────────────────────────────────────────────────────

export async function executeTool(name, args) {
  // Normalize identity fields in case the LLM passes the raw client: form
  if (args.userIdentity) args = { ...args, userIdentity: normalizeIdentity(args.userIdentity) };
  if (args.userId)       args = { ...args, userId:       normalizeIdentity(args.userId) };
  if (args.email)        args = { ...args, email:        normalizeIdentity(args.email) };

  if (HANDOVER_TOOLS.has(name)) {
    const url = HANDOVER_ENDPOINTS[name];
    if (!url) {
      const envVar = name === 'studio_handover' ? 'STUDIO_HANDOVER_URL' : 'FLEX_HANDOVER_URL';
      return { error: `${name} not configured — set ${envVar} in .env`, _endCall: true };
    }
    try {
      const res = await fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(args),
      });
      return { ...(await res.json()), _endCall: true };
    } catch (err) {
      return { error: `Handover failed: ${err.message}`, _endCall: true };
    }
  }

  switch (name) {
    case 'get_banking_data':        return execGetBankingData(args);
    case 'get_investment_data':     return execGetInvestmentData(args);
    case 'get_customer_profile':    return execGetCustomerProfile(args);
    case 'get_last_segment_events': return execGetLastSegmentEvents(args);
    case 'get_stocks_data':         return execGetStocksData(args);
    case 'invest_money':            return execInvestMoney(args);
    default:                        return { error: `Unknown tool: ${name}` };
  }
}

// ─── Tool implementations ───────────────────────────────────────────────────

async function execGetBankingData({ userId }) {
  if (!SYNC_SERVICE_SID) return { error: 'SYNC_SERVICE_SID not configured' };
  try {
    const [acctItem, creditItem, loyaltyItem, investItem] = await Promise.all([
      syncGetItem(userId, 'account_balance'),
      syncGetItem(userId, 'credit_card'),
      syncGetItem(userId, 'loyalty_points'),
      syncGetItem(userId, 'investment_balance'),
    ]);
    return {
      success:           true,
      balance:           (acctItem   ?? BANKING_DEFAULTS.account_balance).balance,
      transactions:      (acctItem   ?? BANKING_DEFAULTS.account_balance).transactions ?? [],
      creditDebt:        (creditItem ?? BANKING_DEFAULTS.credit_card).balance,
      loyaltyPoints:     (loyaltyItem ?? BANKING_DEFAULTS.loyalty_points).balance,
      investmentBalance: (investItem ?? BANKING_DEFAULTS.investment_balance).balance,
    };
  } catch (err) {
    return { error: `Failed to fetch banking data: ${err.message}` };
  }
}

async function execGetInvestmentData({ userId }) {
  if (!SYNC_SERVICE_SID) return { error: 'SYNC_SERVICE_SID not configured' };
  try {
    const item         = await syncGetItem(userId, 'investment_balance');
    const inv          = item ?? BANKING_DEFAULTS.investment_balance;
    return {
      success:           true,
      totalBalance:      inv.balance ?? 0,
      investments:       inv.investments ?? [],
      availableProducts: Object.values(INVESTMENT_PRODUCTS),
    };
  } catch (err) {
    return { error: `Failed to fetch investment data: ${err.message}` };
  }
}

async function execGetCustomerProfile({ email }) {
  if (!SEGMENT_SPACE_ID || !SEGMENT_SECRET) return { error: 'Segment not configured' };
  const identifier = email.includes('@')
    ? `email:${encodeURIComponent(email)}`
    : `phone:${encodeURIComponent(email)}`;
  const url = `https://profiles.segment.com/v1/spaces/${SEGMENT_SPACE_ID}/collections/users/profiles/${identifier}/traits?limit=200`;
  try {
    const res = await fetch(url, { headers: segmentHeaders() });
    if (!res.ok) return { error: `Segment profile error: ${res.status}` };
    const data = await res.json();
    return { success: true, traits: data.traits ?? {} };
  } catch (err) {
    return { error: `Failed to fetch profile: ${err.message}` };
  }
}

async function execGetLastSegmentEvents({ email }) {
  if (!SEGMENT_SPACE_ID || !SEGMENT_SECRET) return { error: 'Segment not configured' };
  const identifier = email.includes('@')
    ? `email:${encodeURIComponent(email)}`
    : `phone:${encodeURIComponent(email)}`;
  const url = `https://profiles.segment.com/v1/spaces/${SEGMENT_SPACE_ID}/collections/users/profiles/${identifier}/events?limit=10`;
  try {
    const res = await fetch(url, { headers: segmentHeaders() });
    if (!res.ok) return { error: `Segment events error: ${res.status}` };
    const data = await res.json();
    return { success: true, events: data.data ?? [] };
  } catch (err) {
    return { error: `Failed to fetch events: ${err.message}` };
  }
}

async function execGetStocksData({ ticker, request_type = 'stocks' }) {
  if (!ALPHA_VANTAGE_KEY) return { error: 'ALPHA_VANTAGE_API_KEY not configured' };

  const s = encodeURIComponent(ticker);
  const k = encodeURIComponent(ALPHA_VANTAGE_KEY);

  let alphaUrl;
  switch (request_type.toLowerCase()) {
    case 'stocks':       alphaUrl = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${s}&outputsize=compact&apikey=${k}`; break;
    case 'news':         alphaUrl = `https://www.alphavantage.co/query?function=NEWS_SENTIMENT&tickers=${s}&apikey=${k}`;                      break;
    case 'company-info': alphaUrl = `https://www.alphavantage.co/query?function=OVERVIEW&symbol=${s}&apikey=${k}`;                            break;
    case 'etf':          alphaUrl = `https://www.alphavantage.co/query?function=ETF_PROFILE&symbol=${s}&apikey=${k}`;                         break;
    default:             return { error: "Invalid request_type. Use 'stocks', 'etf', 'news', or 'company-info'." };
  }

  try {
    const res  = await fetch(alphaUrl, { signal: AbortSignal.timeout(15000) });
    const data = await res.json();

    const apiErr = data?.['Error Message'] || data?.['Information'] || data?.['Note'];
    if (!apiErr) {
      return { success: true, request_type, symbol: ticker, data, meta: { provider: 'alpha_vantage' } };
    }

    // Fall back to Twelve Data on rate-limit or premium errors for time series
    const canFallback = /frequency|rate limit|call frequency|premium|upgrade|subscribe/i.test(apiErr);
    if (canFallback && request_type.toLowerCase() === 'stocks' && TWELVE_DATA_KEY) {
      const tRes  = await fetch(
        `https://api.twelvedata.com/time_series?symbol=${s}&interval=1day&outputsize=100&apikey=${encodeURIComponent(TWELVE_DATA_KEY)}`,
        { signal: AbortSignal.timeout(15000) }
      );
      const tData = await tRes.json();
      if (tData?.status !== 'error') {
        return { success: true, request_type, symbol: ticker, data: tData, meta: { provider: 'twelve_data', fallback_from: 'alpha_vantage' } };
      }
    }

    return { error: apiErr, request_type, symbol: ticker };
  } catch (err) {
    return { error: `Stocks request failed: ${err.message}` };
  }
}

async function execInvestMoney({ userIdentity, amount, productId }) {
  if (!SYNC_SERVICE_SID) return { error: 'SYNC_SERVICE_SID not configured' };

  const product = INVESTMENT_PRODUCTS[productId];
  if (!product) return { error: 'Invalid investment product.' };

  const investmentAmount = parseFloat(amount);
  if (investmentAmount < product.minInvestment) {
    return { error: `Minimum investment for ${product.name} is $${product.minInvestment}.` };
  }

  try {
    const acctItem = await syncGetItem(userIdentity, 'account_balance');
    if (!acctItem) return { error: 'Account not found.' };

    const accountBalance = parseFloat(acctItem.balance ?? 0);
    if (accountBalance < investmentAmount) return { error: 'Insufficient funds.' };

    const investItem  = await syncGetItem(userIdentity, 'investment_balance');
    let investBalance = parseFloat((investItem ?? BANKING_DEFAULTS.investment_balance).balance ?? 0);
    let investments   = (investItem ?? BANKING_DEFAULTS.investment_balance).investments ?? [];

    // Deduct from account balance
    const newAccountBalance = accountBalance - investmentAmount;
    await syncSetItem(userIdentity, 'account_balance', {
      balance:      newAccountBalance,
      transactions: acctItem.transactions ?? [],
    });

    // Update or create investment position
    const idx = investments.findIndex(inv => inv.productId === productId);
    if (idx >= 0) {
      investments[idx].totalInvested += investmentAmount;
      investments[idx].currentValue  += investmentAmount;
      investments[idx].lastUpdated    = new Date().toISOString();
    } else {
      investments.push({
        productId,
        productName:   product.name,
        totalInvested: investmentAmount,
        currentValue:  investmentAmount,
        riskLevel:     product.riskLevel,
        startDate:     new Date().toISOString(),
        lastUpdated:   new Date().toISOString(),
      });
    }

    investBalance += investmentAmount;
    await syncSetItem(userIdentity, 'investment_balance', { balance: investBalance, investments });

    return {
      success:                true,
      message:                `Successfully invested $${investmentAmount} in ${product.name}.`,
      newAccountBalance,
      totalInvestmentBalance: investBalance,
      investment:             investments.find(inv => inv.productId === productId),
    };
  } catch (err) {
    return { error: `Investment failed: ${err.message}` };
  }
}
