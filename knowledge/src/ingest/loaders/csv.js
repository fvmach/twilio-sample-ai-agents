import { readFileSync } from 'fs';

/**
 * Parse a CSV file into an array of row objects.
 * Uses the first line as column headers.
 * No external deps — handles simple CSV (no quoted commas).
 *
 * @param {string} filePath  absolute path
 * @returns {Record<string, string>[]}
 */
export function loadCsv(filePath) {
  const text  = readFileSync(filePath, 'utf8').trim();
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];

  const headers = lines[0].split(',').map(h => h.trim());

  return lines.slice(1).map(line => {
    const values = line.split(',').map(v => v.trim());
    return Object.fromEntries(headers.map((h, i) => [h, values[i] ?? '']));
  });
}
