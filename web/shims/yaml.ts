/**
 * Browser stub for the `yaml` package.
 *
 * Only src/config/loader.ts (loadConfig) parses YAML. The browser demo never
 * loads YAML files, so this stub keeps the parser out of the bundle while
 * failing loudly if anything unexpectedly tries to parse YAML client-side.
 */
export function parse(): never {
  throw new Error("YAML parsing is not available in the browser demo (loadConfig is server-side only)");
}
