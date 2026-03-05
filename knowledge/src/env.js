// Loads .env from voice/ (sibling to knowledge/ at the repo root).
// Imported before any OpenAI or env-dependent code in this module.
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dir, '../../voice/.env') });
