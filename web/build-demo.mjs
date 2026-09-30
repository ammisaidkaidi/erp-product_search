/**
 * Builds the self-contained demo page: docs/index.html
 *
 * 1. Bundles web/demo-main.ts with esbuild (IIFE, minified, ES2020):
 *    - node:crypto aliased to web/shims/node-crypto.ts (bit-exact sha1/sha256)
 *    - a one-line prelude shims `process.env` reads in DEFAULT_CONFIG
 *    - the fixture catalog (fixtures/catalog-fr.json) is inlined into the bundle
 * 2. Injects the bundle into web/index.html at the __DEMO_BUNDLE__ marker.
 *
 * The output is a SINGLE file with zero external references — it works from a
 * web server, from file://, and inside sandboxed iframe previews.
 *
 * Run: npm run build:web
 */
import { build } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outfile = path.join(root, "docs", "index.html");

const result = await build({
  entryPoints: [path.join(root, "web", "demo-main.ts")],
  bundle: true,
  minify: true,
  format: "iife",
  target: ["es2020"],
  write: false,
  alias: {
    "node:crypto": path.join(root, "web", "shims", "node-crypto.ts"),
    // fs + yaml are only used by loadConfig (server-side config files);
    // the demo wires DEFAULT_CONFIG programmatically. See the shim headers.
    "node:fs/promises": path.join(root, "web", "shims", "node-fs-promises.ts"),
    yaml: path.join(root, "web", "shims", "yaml.ts"),
  },
  banner: {
    // DEFAULT_CONFIG reads process.env.PG* at module load; unused with the
    // memory store but must not throw in the browser.
    js: "globalThis.process=globalThis.process||{env:{}};",
  },
  legalComments: "none",
  logLevel: "info",
});

const bundle = result.outputFiles[0].text;
if (bundle.includes("</script")) {
  throw new Error("bundle contains '</script' — cannot inline into HTML safely");
}

const template = readFileSync(path.join(root, "web", "index.html"), "utf8");
if (!template.includes("/*__DEMO_BUNDLE__*/")) {
  throw new Error("web/index.html is missing the __DEMO_BUNDLE__ marker");
}
const html = template.replace("/*__DEMO_BUNDLE__*/", () => bundle);

mkdirSync(path.dirname(outfile), { recursive: true });
writeFileSync(outfile, html);

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
console.log(`✓ demo page written: ${path.relative(root, outfile)} (html ${kb(html.length)}, bundle ${kb(bundle.length)})`);
