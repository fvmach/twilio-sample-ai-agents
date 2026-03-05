import './env.js'; // must be first — loads .env before OpenAI client is created
import * as lancedb from '@lancedb/lancedb';
import OpenAI       from 'openai';
import { DB_PATH, TABLE_NAME } from './schema.js';

// Lazy init — client created on first use, after env.js has run
let _openai = null;
function getOpenAI() {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}
const EMBED_MODEL = 'text-embedding-3-small';
const TOP_K       = 3;
// LanceDB returns _distance (lower = more similar, cosine: 0-2)
// Threshold of 0.8 keeps only results with cosine similarity > 0.6
const MAX_DISTANCE = 0.8;

// Module-level singletons — opened once on first call, reused for all subsequent calls
let _table = null;

async function getTable() {
  if (_table) return _table;
  const db     = await lancedb.connect(DB_PATH);
  const names  = await db.tableNames();
  if (!names.includes(TABLE_NAME)) return null; // not yet ingested
  _table = await db.openTable(TABLE_NAME);
  return _table;
}

/**
 * Search the knowledge base for chunks relevant to a query.
 *
 * Returns a plain-text context block ready to inject as a system message,
 * or null if the DB is missing or no relevant results were found.
 * Designed to degrade silently so the voice server works before ingestion.
 *
 * @param {string}  query
 * @param {object}  [options]
 * @param {string}  [options.agent]  filter by agent ('olli', 'sunny', 'max', 'io')
 * @param {number}  [options.topK]   number of results to return (default: 3)
 * @returns {Promise<string | null>}
 */
export async function searchKnowledge(query, { agent, topK = TOP_K } = {}) {
  let table;
  try {
    table = await getTable();
  } catch {
    return null;
  }
  if (!table) return null;

  // Embed query
  let queryVector;
  try {
    const res   = await getOpenAI().embeddings.create({ model: EMBED_MODEL, input: query });
    queryVector = res.data[0].embedding;
  } catch {
    return null;
  }

  // Vector search with optional agent filter
  try {
    let q = table.vectorSearch(queryVector).distanceType('cosine').limit(topK);
    if (agent) {
      q = q.where(`agent = '${agent}' OR agent = 'all'`);
    }
    const rows = await q.toArray();

    const relevant = rows.filter(r => (r._distance ?? 1) < MAX_DISTANCE);
    if (relevant.length === 0) return null;

    const contextLines = relevant.map(r => r.text.trim()).join('\n');
    return [
      'Relevant knowledge base context (use only if applicable, do not quote verbatim):',
      contextLines,
    ].join('\n');
  } catch {
    return null;
  }
}
