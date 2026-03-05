import * as lancedb from '@lancedb/lancedb';
import { randomUUID } from 'crypto';
import { knowledgeSchema, DB_PATH, TABLE_NAME } from '../schema.js';

let _db    = null;
let _table = null;

async function getTable() {
  if (_table) return _table;
  _db = await lancedb.connect(DB_PATH);
  const names = await _db.tableNames();
  _table = names.includes(TABLE_NAME)
    ? await _db.openTable(TABLE_NAME)
    : await _db.createEmptyTable(TABLE_NAME, knowledgeSchema);
  return _table;
}

/**
 * Write a batch of chunks with their embeddings to LanceDB.
 *
 * @param {Array<{
 *   text:        string,
 *   vector:      number[],
 *   source:      string,
 *   source_type: string,
 *   agent:       string,
 *   chunk_index: number
 * }>} records
 */
export async function storeChunks(records) {
  const table = await getTable();
  const now   = new Date().toISOString();

  const rows = records.map(r => ({
    id:           randomUUID(),
    vector:       r.vector,
    text:         r.text,
    source:       r.source,
    source_type:  r.source_type,
    agent:        r.agent ?? 'all',
    chunk_index:  r.chunk_index,
    char_count:   r.text.length,
    ingested_at:  now,
  }));

  await table.add(rows);
}

/**
 * Drop and recreate the table. Used with --reset flag at ingest time.
 */
export async function resetTable() {
  _db    = await lancedb.connect(DB_PATH);
  await _db.dropTable(TABLE_NAME).catch(() => {});
  _table = await _db.createEmptyTable(TABLE_NAME, knowledgeSchema);
  console.log('Table reset.');
}
