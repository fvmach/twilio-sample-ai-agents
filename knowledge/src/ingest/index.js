import '../env.js'; // must be first — loads .env before any API clients initialize
import { readdirSync }        from 'fs';
import { resolve, extname, basename } from 'path';
import { parseArgs }          from 'node:util';
import { chunkText, csvRowToChunk } from './chunker.js';
import { embedTexts }         from './embedder.js';
import { storeChunks, resetTable } from './store.js';
import { crawlWebsite }       from './loaders/web.js';
import { loadTxt }            from './loaders/txt.js';
import { loadCsv }            from './loaders/csv.js';

// ─── Args ──────────────────────────────────────────────────────────────────

const { values: args } = parseArgs({
  options: {
    source: { type: 'string',  default: 'files' }, // 'files' | 'web' | 'all'
    url:    { type: 'string'                     }, // required for web
    dir:    { type: 'string'                     }, // files directory override
    agent:  { type: 'string',  default: 'all'   }, // agent scope
    reset:  { type: 'boolean', default: false    }, // drop + recreate table
  },
});

const DEFAULT_KNOWLEDGE_DIR =
  '/Users/fvieiramachado/Twilio/CX MAS/CR Render Version/Signal SP Session/knowledge';

// ─── Reset ─────────────────────────────────────────────────────────────────

if (args.reset) {
  await resetTable();
}

const allRecords = [];

// ─── File ingestion ─────────────────────────────────────────────────────────

if (args.source === 'files' || args.source === 'all') {
  const dir   = args.dir ?? DEFAULT_KNOWLEDGE_DIR;
  const files = readdirSync(dir)
    .filter(f => ['.txt', '.csv'].includes(extname(f)));

  if (files.length === 0) {
    console.log(`No .txt or .csv files found in ${dir}`);
  }

  for (const file of files) {
    const fullPath = resolve(dir, file);
    const ext      = extname(file).slice(1);
    const src      = basename(file);

    let chunks;

    if (ext === 'csv') {
      const rows = loadCsv(fullPath);
      chunks = rows.map(r => csvRowToChunk(r)).filter(Boolean);
    } else {
      chunks = chunkText(loadTxt(fullPath));
    }

    console.log(`  ${src}: ${chunks.length} chunk${chunks.length !== 1 ? 's' : ''}`);

    chunks.forEach((text, i) => allRecords.push({
      text,
      source:      src,
      source_type: ext,
      agent:       args.agent,
      chunk_index: i,
    }));
  }
}

// ─── Web ingestion ──────────────────────────────────────────────────────────

if (args.source === 'web' || args.source === 'all') {
  if (!args.url) {
    console.error('--url is required for web ingestion');
    process.exit(1);
  }

  console.log(`\nCrawling ${args.url}...`);
  const pages = await crawlWebsite(args.url);

  for (const { url, text } of pages) {
    if (!text.trim()) continue;
    const chunks = chunkText(text);
    if (chunks.length === 0) continue;
    console.log(`  ${url}: ${chunks.length} chunk${chunks.length !== 1 ? 's' : ''}`);
    chunks.forEach((text, i) => allRecords.push({
      text,
      source:      url,
      source_type: 'web',
      agent:       args.agent,
      chunk_index: i,
    }));
  }
}

// ─── Embed + store ──────────────────────────────────────────────────────────

if (allRecords.length === 0) {
  console.log('\nNothing to ingest.');
  process.exit(0);
}

console.log(`\nEmbedding ${allRecords.length} chunk${allRecords.length !== 1 ? 's' : ''}...`);
const vectors     = await embedTexts(allRecords.map(r => r.text));
const withVectors = allRecords.map((r, i) => ({ ...r, vector: vectors[i] }));

await storeChunks(withVectors);
console.log(`Done. Stored ${withVectors.length} chunks in LanceDB.`);
