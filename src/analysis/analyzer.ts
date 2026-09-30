/**
 * Shared deterministic text analyzer for product search.
 *
 * Used by the BM25F index (document side) and the query normalizer (query
 * side) so that documents and queries produce comparable terms.
 *
 * Design goals (product search, NOT web search):
 *  - preserve product codes:   "T-110-B45"  -> canonical "T110B45" + boundary parts
 *  - preserve dimension pairs: "110 x 45", "110*45", "110/45", "110x45" -> "110x45"
 *  - split attached units:     "110mm" -> ["110", "mm"] (matches "110 mm")
 *  - accent/case folding:      "Évacuation" -> "evacuation"
 *  - light French plural variants: "tubes" -> also indexes "tube"
 *
 * Everything here is pure and deterministic; golden tests lock the behavior.
 */

export type TokenKind = "word" | "number" | "dimension" | "unit" | "code";

export interface AnalyzedTerm {
  /** Folded term as stored in indexes. */
  term: string;
  kind: TokenKind;
  /** Variants (e.g. singularized plural) carry tf=1 instead of real tf. */
  isVariant: boolean;
}

/** Fold case and accents, handling letters that do not decompose via NFD. */
export function foldText(input: string): string {
  const pre = input
    .replace(/ø/g, "o")
    .replace(/Ø/g, "o")
    .replace(/æ/g, "ae")
    .replace(/Æ/g, "ae")
    .replace(/œ/g, "oe")
    .replace(/Œ/g, "oe")
    .replace(/ß/g, "ss")
    .toLowerCase();
  return pre.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/** Canonicalize a product code: uppercase, strip separators. "T-110-B45" -> "T110B45". */
export function canonicalCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** True when a token looks like a product reference (letters+digits mixed, or long digit runs). */
export function isCodeShaped(token: string): boolean {
  const t = token.toUpperCase();
  return /^[A-Z0-9-]+$/.test(t) && /[A-Z]/.test(t) && /[0-9]/.test(t) && t.replace(/-/g, "").length >= 4;
}

const DIMENSION_SEPARATOR = /(\d+(?:[.,]\d+)?)\s*[x×*\/]\s*(?=\d)/gi;

/**
 * Pre-process raw text before tokenization:
 *  - diameter symbols: "Ø110", "ø 110" -> "dia 110"
 *  - dimension pairs:  "110 x 45", "110*45", "110/45", "110x45" -> "110x45"
 *  - NFKC normalization
 */
export function preprocessText(input: string): string {
  let s = input.normalize("NFKC");
  // Diameter-ish prefixes glued to numbers (Ø110, ⌀110, Ø 110, D110, DN110, Dn 110).
  s = s.replace(/[⌀Øø]\s*(?=\d)/g, "dia ");
  s = s.replace(/\bDN\s*(?=\d)/gi, "dia ");
  s = s.replace(/\bD\s?(?=\d)/g, "dia ");
  // Dimension separators -> canonical "x" glued form.
  s = s.replace(DIMENSION_SEPARATOR, (_m, num1: string) => `${num1.replace(",", ".")}x`);
  // French decimal comma -> dot ("2,5 kg" -> "2.5 kg").
  s = s.replace(/(\d),(\d)/g, "$1.$2");
  return s;
}

/** Remove common French plural suffix as a matching variant. Conservative: len >= 4. */
function depluralize(word: string): string | null {
  if (word.length < 4) return null;
  if (word.endsWith("s")) return word.slice(0, -1);
  if (word.endsWith("x")) return word.slice(0, -1);
  return null;
}

const NUMBER_RE = /^\d+(?:\.\d+)?$/;
const DIMENSION_RE = /^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/;
const ATTACHED_UNIT_RE = /^(\d+(?:\.\d+)?)([a-z°²³µμ]+)$/;

/**
 * Token scanner (ordered alternation):
 *  1. dimension chains glued by x:  "110x45", "110x45x2"
 *  2. numbers with optional decimal: "110", "2.5"
 *  3. general alphanumeric runs:     "tube", "T110B45", "m2"
 * Separators (punctuation, spaces, |) are consumed by the regex and dropped.
 */
const TOKEN_RE = /\d+(?:[.,]\d+)?(?:x\d+(?:[.,]\d+)?)*|\d+(?:[.,]\d+)?|[\p{L}\p{N}]+/gu;

/**
 * Tokenize free text (names, attribute labels/values, queries) into analyzed terms.
 * Pure function of the input.
 */
export function analyzeText(input: string, options: { pluralVariants?: boolean } = {}): AnalyzedTerm[] {
  const pluralVariants = options.pluralVariants ?? true;
  const preprocessed = preprocessText(input);
  const rawTokens = preprocessed.match(TOKEN_RE) ?? [];

  const terms: AnalyzedTerm[] = [];
  for (const raw of rawTokens) {
    const folded = foldText(raw);
    if (folded.length === 0) continue;

    const dim = DIMENSION_RE.exec(folded);
    if (dim) {
      const composite = `${dim[1]}x${dim[2]}`;
      terms.push({ term: composite, kind: "dimension", isVariant: false });
      terms.push({ term: dim[1]!, kind: "number", isVariant: false });
      terms.push({ term: dim[2]!, kind: "number", isVariant: false });
      continue;
    }

    if (NUMBER_RE.test(folded)) {
      terms.push({ term: folded, kind: "number", isVariant: false });
      continue;
    }

    const attached = ATTACHED_UNIT_RE.exec(folded);
    if (attached) {
      terms.push({ term: attached[1]!, kind: "number", isVariant: false });
      terms.push({ term: attached[2]!, kind: "unit", isVariant: false });
      continue;
    }

    terms.push({ term: folded, kind: "word", isVariant: false });
    if (pluralVariants) {
      const singular = depluralize(folded);
      if (singular && singular.length >= 3) {
        terms.push({ term: singular, kind: "word", isVariant: true });
      }
    }
  }
  return terms;
}

/**
 * Tokenize a product code into indexable terms.
 * "T-110-B45" -> ["t110b45" (exact canonical), "t", "110", "b", "45" (boundary parts), "t-110-b45" (raw folded)]
 */
export function analyzeCode(code: string): AnalyzedTerm[] {
  const terms: AnalyzedTerm[] = [];
  const canonical = canonicalCode(code).toLowerCase();
  if (canonical.length > 0) {
    terms.push({ term: canonical, kind: "code", isVariant: false });
    // Letter/digit boundary splits enable partial-code matching ("110B45" -> ["110","b","45"]).
    const parts = canonical.split(/(?<=[0-9])(?=[a-z])|(?<=[a-z])(?=[0-9])/g).filter((p) => p.length > 0);
    for (const part of parts) {
      terms.push({ term: part, kind: "code", isVariant: true });
    }
  }
  const rawFolded = foldText(code);
  if (rawFolded !== canonical && rawFolded.length > 0) {
    terms.push({ term: rawFolded, kind: "code", isVariant: true });
  }
  return terms;
}
