const CHUNK_SIZE    = 400; // characters
const CHUNK_OVERLAP = 80;  // characters
const MIN_LENGTH    = 20;  // drop fragments shorter than this

/**
 * Split text into overlapping chunks.
 * Strategy: paragraph-first, sliding-window fallback for oversized paragraphs.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function chunkText(text) {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  const paragraphs = normalized.split(/\n{2,}/);
  const chunks     = [];
  let   buffer     = '';

  for (const para of paragraphs) {
    const p = para.trim();
    if (!p) continue;

    const joined = buffer ? buffer + '\n\n' + p : p;

    if (joined.length <= CHUNK_SIZE) {
      buffer = joined;
    } else {
      if (buffer) chunks.push(buffer.trim());

      if (p.length > CHUNK_SIZE) {
        // Sliding window over oversized paragraph
        let start = 0;
        while (start < p.length) {
          const end   = Math.min(start + CHUNK_SIZE, p.length);
          const slice = p.slice(start, end);
          chunks.push(slice.trim());
          if (end === p.length) break;
          start += CHUNK_SIZE - CHUNK_OVERLAP;
        }
        buffer = '';
      } else {
        buffer = p;
      }
    }
  }

  if (buffer) chunks.push(buffer.trim());

  return chunks.filter(c => c.length >= MIN_LENGTH);
}

/**
 * Convert a CSV row object into a single chunk string.
 * Column names become part of the text for semantic richness.
 *
 * @param {Record<string, string>} row
 * @returns {string}
 */
export function csvRowToChunk(row) {
  return Object.entries(row)
    .filter(([, v]) => v && String(v).trim())
    .map(([k, v]) => `${k}: ${String(v).trim()}`)
    .join(' | ');
}
