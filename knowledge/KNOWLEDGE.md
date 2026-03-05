# Knowledge Module

Shared RAG (Retrieval-Augmented Generation) module for AI agents.

Provides a single `searchKnowledge()` function that any channel can call to retrieve relevant context before calling the LLM. Sources can be plain text files, CSV files, or any public website.

---

## How It Works

```
Sources (files, websites)
 │
 ▼
ingest CLI
 │
 ├── load → txt / csv / web crawler
 ├── chunk → paragraph-first, 400-char chunks with 80-char overlap
 ├── embed → OpenAI text-embedding-3-small (batched)
 └── store → LanceDB (knowledge/db/)

 ┌────────────────┐
At call time: │ searchKnowledge│
 user utterance ──► │ embed query │ ──► LanceDB top-3
 │ return context│
 └────────────────┘
 │
 injected as system message
 into LLM messages array
```

---

## File Structure

```
knowledge/
├── package.json
├── KNOWLEDGE.md
├── .gitignore (db/ is gitignored)
├── db/ (LanceDB data — auto-created, not committed)
└── src/
 ├── schema.js Arrow schema + DB_PATH resolution
 ├── search.js searchKnowledge() — public API
 └── ingest/
 ├── index.js CLI entry point
 ├── chunker.js paragraph-first + sliding window chunker
 ├── embedder.js OpenAI batched embedding
 ├── store.js LanceDB write + reset
 └── loaders/
 ├── txt.js plain text loader
 ├── csv.js CSV row-per-chunk loader
 └── web.js axios + cheerio website crawler
```

---

## LanceDB Schema

| Field | Type | Description |
|-------|------|-------------|
| `id` | String | UUID |
| `vector` | Float32[1536] | text-embedding-3-small output |
| `text` | String | raw chunk text |
| `source` | String | file basename or crawled URL |
| `source_type` | String | `txt`, `csv`, `web` |
| `agent` | String | `your-agent`, `sunny`, `max`, `io`, or `all` |
| `chunk_index` | Int32 | 0-based position within source |
| `char_count` | Int32 | character length |
| `ingested_at` | String | ISO 8601 timestamp |

---

## Ingestion

### Install

```bash
cd knowledge
npm install
```

### Ingest knowledge files

```bash
# Ingest .txt and .csv files from the default knowledge directory
node src/ingest/index.js --source files

# Ingest from a custom directory
node src/ingest/index.js --source files --dir /path/to/your/files

# Drop and recreate the table before ingesting
node src/ingest/index.js --source files --reset
```

### Ingest a public website

```bash
node src/ingest/index.js --source web --url https://your-site.com
```

The crawler:
- Respects `robots.txt` and `noindex` meta tags
- Strips nav, footer, header, scripts, and styles before extracting text
- Crawls up to 50 pages, 2 concurrent requests, 500ms between batches
- User-agent: `KnowledgeBot/1.0`

### Ingest everything

```bash
node src/ingest/index.js --source all --url https://your-site.com --reset
```

### Scope to a specific agent

```bash
node src/ingest/index.js --source files --agent your-agent
```

When `--agent` is set, all ingested chunks are tagged with that agent name and can be filtered at search time.

---

## Search API

```js
import { searchKnowledge } from '../knowledge/src/search.js';

// Basic search
const context = await searchKnowledge('how do I open an account');

// Filtered by agent
const context = await searchKnowledge('investment options', { agent: 'your-agent' });

// Returns: string | null
// - string: plain-text context block ready to inject as a system message
// - null: DB not found, or no results above similarity threshold
```

The function is null-safe — if the database has not been created yet, it returns `null` immediately with no error. Channels degrade gracefully to LLM-only mode.

---

## Chunking

- **Chunk size**: 400 characters
- **Overlap**: 80 characters
- **Strategy**: paragraph-first (`\n\n` splits), sliding window fallback for long paragraphs
- **CSV rows**: each row becomes one chunk — column names included as `"Key: Value | Key: Value"`
- **Min chunk length**: 20 characters (noise fragments discarded)

---

## Default Knowledge Directory

```
${PROJECT_ROOT}/knowledge/
```

Override with `--dir` at ingest time.
