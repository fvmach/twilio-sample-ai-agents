import '../env.js'; // must be first — loads .env before OpenAI client is created
import OpenAI from 'openai';

// Lazy init — client created on first use, after env.js has run
let _openai = null;
function getOpenAI() {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

const EMBED_MODEL = 'text-embedding-3-small';
const BATCH_SIZE  = 100; // conservative — limit is 2048
const BATCH_DELAY = 200; // ms between batches

/**
 * Embed an array of strings in batches.
 * Returns a parallel array of embedding vectors (number[][]).
 *
 * @param {string[]} texts
 * @returns {Promise<number[][]>}
 */
export async function embedTexts(texts) {
  const openai  = getOpenAI();
  const results = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const res   = await openai.embeddings.create({ model: EMBED_MODEL, input: batch });

    for (const item of res.data) {
      results.push(item.embedding);
    }

    if (i + BATCH_SIZE < texts.length) {
      await new Promise(r => setTimeout(r, BATCH_DELAY));
    }
  }

  return results;
}

/**
 * Embed a single query string. Used at search time.
 *
 * @param {string} text
 * @returns {Promise<number[]>}
 */
export async function embedOne(text) {
  const openai = getOpenAI();
  const res    = await openai.embeddings.create({ model: EMBED_MODEL, input: text });
  return res.data[0].embedding;
}
