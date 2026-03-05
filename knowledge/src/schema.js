import * as arrow from 'apache-arrow';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';

export const EMBEDDING_DIMS = 1536; // text-embedding-3-small
export const TABLE_NAME     = 'owl_knowledge';

// Resolve db/ relative to this file — stable regardless of the importing module
const __dir  = dirname(fileURLToPath(import.meta.url));
export const DB_PATH = join(__dir, '../../db');

export const knowledgeSchema = new arrow.Schema([
  new arrow.Field('id',          new arrow.Utf8(),    false),
  new arrow.Field('vector',      new arrow.FixedSizeList(
                                   EMBEDDING_DIMS,
                                   new arrow.Field('item', new arrow.Float32(), false)
                                 ),                   false),
  new arrow.Field('text',        new arrow.Utf8(),    false),
  new arrow.Field('source',      new arrow.Utf8(),    false),
  new arrow.Field('source_type', new arrow.Utf8(),    false),
  new arrow.Field('agent',       new arrow.Utf8(),    false),
  new arrow.Field('chunk_index', new arrow.Int32(),   false),
  new arrow.Field('char_count',  new arrow.Int32(),   false),
  new arrow.Field('ingested_at', new arrow.Utf8(),    false),
]);
