import { canonicalCode, foldText, isCodeShaped } from "../analysis/analyzer.js";
import type { Correction, ExtractedAttribute, NormalizeContext, TokenProvenance } from "../core/types.js";
import { DETERMINISTIC_NORMALIZER_VERSION } from "../core/version.js";
import type { DeterministicNormalization, LanguageNormalizer } from "./interfaces.js";
import { closestWord } from "./damerau.js";
import type { LanguageDictionary } from "./dictionaries/fr.js";

export interface FrenchNormalizerOptions {
  dictionary: LanguageDictionary;
  typo: { enabled: boolean; maxEditDistance: 1 | 2; minTokenLength: number };
}

const NUMBER_UNIT_RE = /^(\d+(?:[.,]\d+)?)(mm|cm|dm|m|kg|g|l|cl|ml)$/i;
const NUMBER_RE = /^\d+(?:[.,]\d+)?$/;
const DIMENSION_RE = /^(\d+(?:[.,]\d+)?)\s*[x×*\/]\s*(\d+(?:[.,]\d+)?)$/i;
const DIAMETER_PREFIX_RE = /^(?:ø|⌀|dn|dia|diam|d)\s*(\d+(?:[.,]\d+)?)(mm|cm|dm|m)?$/i;
const UPPERCASE_CODE_RE = /^[A-Z]{1,4}$/;
const DIGITS_RE = /^\d{2,}$/;

/**
 * Deterministic French query normalizer.
 *
 * Guarantees (locked by tests):
 *  - never invents attributes: every extracted attribute comes from an explicit
 *    deterministic rule applied to observed input (symbol Ø, keyword+number,
 *    dictionary word) and carries its rule id + provenance;
 *  - typo correction only replaces a token when a UNIQUE vocabulary word is
 *    strictly closer than any other candidate, and never touches code-shaped
 *    tokens, numbers, or words that already exist;
 *  - numbers keep their identity: no blind unit conversion of bare values;
 *    explicit units are canonicalized to millimeters only for extracted
 *    dimensions, and any conversion is flagged as inferred;
 *  - product codes are detected (glued, hyphenated, spaced) and canonicalized
 *    ("T-110-B45" -> "T110B45") without altering the original text.
 */
export class FrenchNormalizer implements LanguageNormalizer {
  readonly language = "fr";
  readonly version = `${DETERMINISTIC_NORMALIZER_VERSION}-fr`;

  private readonly dictionary: LanguageDictionary;
  private readonly typo: FrenchNormalizerOptions["typo"];
  private readonly synonymIndex: Map<string, string[]>;

  constructor(options: FrenchNormalizerOptions) {
    this.dictionary = options.dictionary;
    this.typo = options.typo;
    this.synonymIndex = new Map();
    for (const group of options.dictionary.synonyms) {
      for (const word of group) {
        this.synonymIndex.set(word, group.filter((w) => w !== word));
      }
    }
  }

  normalizeDet(raw: string, ctx: NormalizeContext = {}): DeterministicNormalization {
    const preprocessed = raw.normalize("NFKC").replace(/\s+/g, " ").trim();
    const notes: string[] = [];
    if (preprocessed.length === 0) {
      return { normalized: "", tokens: [], tokenProvenance: {}, codes: [], attributes: {}, corrections: [], notes };
    }

    const corrections: Correction[] = [];
    const tokenProvenance: Record<string, TokenProvenance> = {};
    const attributes: Record<string, ExtractedAttribute> = {};
    const codes: string[] = [];
    const outputTokens: string[] = [];
    const vocab = this.buildVocabulary(ctx);

    // Tokenize: protect decimal separators (comma AND dot between digits), keep
    // hyphens (product codes), split on any other punctuation — "PVC/PPR" ->
    // PVC, PPR; "T-110-B45" and "Ø0.11m" stay single tokens.
    const rawTokens = preprocessed
      .replace(/(\d)[,.](\d)/g, "$1\u0001$2")
      .split(/\s+/)
      .flatMap((t) => t.split(/[^\p{L}\p{N}\u0001-]+/u))
      .map((t) => t.replace(/\u0001/g, ".").replace(/^-+|-+$/g, ""))
      .filter((t) => t.length > 0);

    const folded = rawTokens.map((t) => foldText(t));
    const consumed = new Set<number>();
    // index -> captured value for tokens like "Ø110" (unit may follow as "mm")
    const gluedDiameter = new Map<number, string>();

    for (let i = 0; i < rawTokens.length; i++) {
      const rawToken = rawTokens[i]!;
      const fold = folded[i]!;
      if (consumed.has(i)) continue;

      // "ABC 123" / "T 110" -> canonical code (uppercase letter run + digits only)
      if (UPPERCASE_CODE_RE.test(rawToken) && rawTokens[i + 1] && DIGITS_RE.test(rawTokens[i + 1]!)) {
        const joined = canonicalCode(`${rawToken}${rawTokens[i + 1]}`);
        codes.push(joined);
        corrections.push({ from: `${rawToken} ${rawTokens[i + 1]}`, to: joined, kind: "abbreviation", rule: "code:join" });
        outputTokens.push(fold, foldText(rawTokens[i + 1]!));
        tokenProvenance[fold] = "observed";
        consumed.add(i + 1);
        continue;
      }

      // dimension composite: "110x45" (order-preserving; parts also emitted)
      const dim = DIMENSION_RE.exec(rawToken);
      if (dim) {
        const first = dim[1]!.replace(",", ".");
        const second = dim[2]!.replace(",", ".");
        const composite = `${first}x${second}`;
        outputTokens.push(composite, first, second);
        tokenProvenance[composite] = "observed";
        continue;
      }

      // glued diameter marker: Ø110 / DN110 / D110 / dia110
      const glued = DIAMETER_PREFIX_RE.exec(rawToken);
      if (glued) {
        this.extractDimension("diameter", glued[1]!, glued[2]?.toLowerCase(), rawToken, attributes, "diameter:symbol");
        outputTokens.push(fold);
        tokenProvenance[fold] = "observed";
        gluedDiameter.set(i, glued[1]!.replace(",", "."));
        continue;
      }

      // number + glued unit: "110mm"
      const numberUnit = NUMBER_UNIT_RE.exec(rawToken);
      if (numberUnit) {
        const value = numberUnit[1]!.replace(",", ".");
        const unit = numberUnit[2]!.toLowerCase();
        outputTokens.push(value, unit);
        tokenProvenance[value] = "observed";
        tokenProvenance[unit] = "observed";
        // only becomes a dimension when a dimension keyword precedes it
        const keyword = this.previousKeyword(folded, i);
        if (keyword) {
          this.extractDimension(keyword.attribute, value, unit, rawToken, attributes, `${keyword.attribute}:keyword-unit`);
        }
        continue;
      }

      // pure number: value of a preceding keyword ("diamètre 110")
      if (NUMBER_RE.test(rawToken)) {
        const value = fold.replace(",", ".");
        outputTokens.push(value);
        tokenProvenance[value] = "observed";
        const keyword = this.previousKeyword(folded, i);
        if (keyword) {
          this.extractDimension(keyword.attribute, value, undefined, rawToken, attributes, `${keyword.attribute}:keyword`);
        }
        continue;
      }

      // code-shaped token: canonicalize, never typo-correct
      if (isCodeShaped(rawToken)) {
        codes.push(canonicalCode(rawToken));
        outputTokens.push(fold);
        tokenProvenance[fold] = "observed";
        continue;
      }

      // unit token alone: "110 mm" spaced, or "Ø110 mm"
      if (this.isUnit(fold) && i >= 1) {
        outputTokens.push(fold);
        tokenProvenance[fold] = "observed";
        const gluedValue = gluedDiameter.get(i - 1);
        if (gluedValue !== undefined) {
          // "Ø110 mm": attach the unit to the extracted symbol dimension
          this.extractDimension("diameter", gluedValue, fold, folded[i - 1]!, attributes, "diameter:symbol-unit", true);
          continue;
        }
        if (NUMBER_RE.test(folded[i - 1]!)) {
          const keyword = this.previousKeyword(folded, i - 1);
          if (keyword) {
            const value = folded[i - 1]!.replace(",", ".");
            this.extractDimension(keyword.attribute, value, fold, folded[i - 1]!, attributes, `${keyword.attribute}:keyword-unit`, true);
          }
        }
        continue;
      }

      // ---- word tokens ----------------------------------------------------
      this.resolveWord(rawToken, fold, vocab, { corrections, tokenProvenance, attributes, outputTokens });
    }

    const tokens: string[] = [];
    for (const token of outputTokens) {
      if (!tokens.includes(token)) tokens.push(token);
    }
    for (const code of codes) {
      const fold = code.toLowerCase();
      if (!tokens.includes(fold)) tokens.push(fold);
    }

    const normalized = this.renderNormalized(rawTokens, folded, corrections);
    return { normalized, tokens, tokenProvenance, codes, attributes, corrections, notes };
  }

  // ------------------------------------------------------------------ internals

  private buildVocabulary(ctx: NormalizeContext): Set<string> {
    const vocab = new Set<string>(this.dictionary.baseVocabulary);
    for (const word of Object.keys(this.dictionary.colors)) vocab.add(word);
    for (const word of Object.keys(this.dictionary.materials)) vocab.add(word);
    for (const group of this.dictionary.synonyms) {
      for (const word of group) vocab.add(word);
    }
    if (ctx.vocabulary) {
      for (const term of ctx.vocabulary) vocab.add(term);
    }
    return vocab;
  }

  /**
   * Resolve a word token: dictionary attributes (color/material), abbreviation
   * expansion, synonym expansion, then conservative typo correction.
   */
  private resolveWord(
    rawToken: string,
    fold: string,
    vocab: Set<string>,
    out: {
      corrections: Correction[];
      tokenProvenance: Record<string, TokenProvenance>;
      attributes: Record<string, ExtractedAttribute>;
      outputTokens: string[];
    },
  ): void {
    let resolved = fold;

    const abbreviation = this.dictionary.abbreviations[fold];
    if (abbreviation) {
      resolved = foldText(abbreviation);
      out.corrections.push({ from: fold, to: abbreviation, kind: "abbreviation", rule: "abbreviation:map" });
      out.tokenProvenance[resolved] = "normalized";
    }

    this.recordVocabularyAttribute(resolved, rawToken, out, "");

    out.outputTokens.push(resolved);
    if (!out.tokenProvenance[resolved]) out.tokenProvenance[resolved] = "observed";

    const synonyms = this.synonymIndex.get(resolved);
    if (synonyms) {
      for (const synonym of synonyms) {
        const synonymFold = foldText(synonym);
        if (!out.outputTokens.includes(synonymFold)) {
          out.outputTokens.push(synonymFold);
          out.tokenProvenance[synonymFold] = "inferred";
          out.corrections.push({ from: resolved, to: synonym, kind: "synonym", rule: "synonym:group" });
        }
      }
    }

    if (this.typo.enabled && resolved.length >= this.typo.minTokenLength && !vocab.has(resolved)) {
      const best = closestWord(resolved, vocab, this.typo.maxEditDistance);
      if (best && best.unique && best.distance > 0) {
        out.corrections.push({ from: resolved, to: best.word, kind: "typo", rule: `typo:damerau-${best.distance}` });
        if (!out.outputTokens.includes(best.word)) out.outputTokens.push(best.word);
        out.tokenProvenance[best.word] = "normalized";
        // the corrected word may hit color/material dictionaries
        this.recordVocabularyAttribute(best.word, resolved, out, "-after-typo");
      } else {
        out.tokenProvenance[resolved] = "unknown";
      }
    }
  }

  /** Attribute extraction from dictionary words — deterministic, never invented. */
  private recordVocabularyAttribute(
    fold: string,
    raw: string,
    out: { corrections: Correction[]; tokenProvenance: Record<string, TokenProvenance>; attributes: Record<string, ExtractedAttribute>; outputTokens: string[] },
    ruleSuffix: string,
  ): void {
    const color = this.dictionary.colors[fold];
    if (color && !out.attributes["color"]) {
      out.attributes["color"] = {
        name: "color",
        value: color,
        raw,
        provenance: "inferred",
        rule: `color:vocabulary${ruleSuffix}`,
      };
    }
    const material = this.dictionary.materials[fold];
    if (material && !out.attributes["material"]) {
      out.attributes["material"] = {
        name: "material",
        value: material,
        raw,
        provenance: "inferred",
        rule: `material:vocabulary${ruleSuffix}`,
      };
    }
  }

  private isUnit(fold: string): boolean {
    return fold in this.dictionary.unitFactors;
  }

  /** Find a dimension keyword within the two tokens preceding `index`. */
  private previousKeyword(folded: string[], index: number): { attribute: string } | null {
    for (let j = index - 1; j >= 0 && j >= index - 2; j--) {
      const candidate = folded[j]!;
      const expanded = this.dictionary.abbreviations[candidate];
      const word = expanded ? foldText(expanded) : candidate;
      if (this.dictionary.diameterKeywords.includes(word)) return { attribute: "diameter" };
      if (this.dictionary.lengthKeywords.includes(word)) return { attribute: "length" };
      if (this.dictionary.widthKeywords.includes(word)) return { attribute: "width" };
    }
    return null;
  }

  /** Record a dimension attribute with unit canonicalization (mm) when needed. */
  private extractDimension(
    name: string,
    value: string,
    unit: string | undefined,
    raw: string,
    attributes: Record<string, ExtractedAttribute>,
    rule: string,
    replaceExisting = false,
  ): void {
    const existing = attributes[name];
    if (existing && !replaceExisting) return;
    const numericValue = value.replace(",", ".");
    let finalValue = numericValue;
    let finalUnit = unit;
    let provenance: TokenProvenance = "observed";
    let finalRule = rule;
    if (unit && unit !== "mm" && this.dictionary.unitFactors[unit] !== undefined) {
      const mm = Number(numericValue) * this.dictionary.unitFactors[unit]!;
      if (Number.isFinite(mm)) {
        finalValue = String(Math.round(mm * 1000) / 1000);
        finalUnit = "mm";
        provenance = "inferred";
        finalRule = `${rule}:unit-convert`;
      }
    }
    attributes[name] = {
      name,
      value: finalValue,
      ...(finalUnit ? { unit: finalUnit } : {}),
      raw,
      provenance,
      rule: finalRule,
    };
  }

  /** Human-readable normalized string: original words with corrections applied. */
  private renderNormalized(rawTokens: string[], folded: string[], corrections: Correction[]): string {
    const byFold = new Map<string, string>();
    for (const correction of corrections) {
      if (correction.kind === "typo" || correction.kind === "abbreviation") {
        byFold.set(foldText(correction.from), correction.to);
      }
    }
    const parts = rawTokens.map((token, i) => {
      if (isCodeShaped(token)) return token;
      const replacement = byFold.get(folded[i]!);
      if (replacement) return replacement;
      return token.toLowerCase();
    });
    return parts.join(" ");
  }
}
