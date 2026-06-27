// Load the .env file BEFORE any other module is evaluated. Several modules read
// process.env at import/module-eval time (passkeys.ts → IRION_RP_ORIGIN/RP_ID,
// session.ts → IRION_SESSION_SECRET, etc.). Because ES `import`s are hoisted and
// evaluated in order, this must be the FIRST import in server.ts — otherwise those
// modules read config before the .env is loaded and silently fall back to defaults
// (which previously dropped the :3006 / Meridian passkey origin).
import { resolve } from 'node:path';

try {
  process.loadEnvFile?.(resolve(import.meta.dirname, '../.env'));
} catch {
  try { process.loadEnvFile?.('.env'); } catch { /* no .env present — use defaults */ }
}
