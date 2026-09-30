/**
 * Browser stub for `node:fs/promises`.
 *
 * Only src/config/loader.ts (loadConfig — reads YAML config files) needs it.
 * The browser demo never loads config from disk; it wires DEFAULT_CONFIG
 * programmatically (web/browser-system.ts). Any accidental fs use fails
 * loudly instead of silently doing nothing.
 */
export function readFile(): Promise<string> {
  return Promise.reject(new Error("fs.readFile is not available in the browser demo (loadConfig is server-side only)"));
}
