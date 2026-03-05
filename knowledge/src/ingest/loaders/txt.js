import { readFileSync } from 'fs';

/**
 * Load a plain text file and return its content.
 *
 * @param {string} filePath  absolute path
 * @returns {string}
 */
export function loadTxt(filePath) {
  return readFileSync(filePath, 'utf8');
}
