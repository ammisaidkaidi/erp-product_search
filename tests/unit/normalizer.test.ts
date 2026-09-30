import { describe, expect, it } from "vitest";
import { FrenchNormalizer } from "../../src/normalize/french.js";
import { DeterministicNormalizer } from "../../src/normalize/deterministic.js";
import { MockNormalizer } from "../../src/normalize/mock.js";
import { FRENCH_DICTIONARY } from "../../src/normalize/dictionaries/fr.js";
import { damerauLevenshtein, closestWord } from "../../src/normalize/damerau.js";
import { DEFAULT_CONFIG } from "../../src/config/schema.js";

const french = new FrenchNormalizer({
  dictionary: FRENCH_DICTIONARY,
  typo: DEFAULT_CONFIG.normalization.typo,
});
const normalizer = new DeterministicNormalizer(french);

async function norm(text: string, vocabulary: string[] = []) {
  return normalizer.normalize(text, vocabulary.length ? { vocabulary } : undefined);
}

describe("damerauLevenshtein", () => {
  it("computes classic distances", () => {
    expect(damerauLevenshtein("blnc", "blanc", 2)).toBe(1);
    expect(damerauLevenshtein("blan", "blanc", 2)).toBe(1);
    expect(damerauLevenshtein("racord", "raccord", 2)).toBe(1);
    expect(damerauLevenshtein("evacuaton", "evacuation", 2)).toBe(1);
    expect(damerauLevenshtein("tube", "tube", 2)).toBe(0);
    expect(damerauLevenshtein("abc", "bca", 2)).toBe(2); // transposition pair
  });

  it("respects the cutoff", () => {
    expect(damerauLevenshtein("tubeeeeeeee", "blanc", 2)).toBe(3);
  });

  it("closestWord prefers unique winners", () => {
    expect(closestWord("blnc", ["blanc", "tube", "gris"], 2)).toEqual({ word: "blanc", distance: 1, unique: true });
    // strictly-closer winner beats a distance-2 candidate
    const match = closestWord("blan", ["blanc", "blanche", "tube"], 2);
    expect(match?.word).toBe("blanc");
    expect(match?.unique).toBe(true);
    // two candidates at the same distance => ambiguous, not correctable
    const ambiguous = closestWord("blan", ["blanc", "blant"], 2);
    expect(ambiguous?.unique).toBe(false);
  });
});

describe("FrenchNormalizer — spec test cases (§36/§37)", () => {
  it("typo: blnc -> blanc (attribute extracted, provenance recorded)", async () => {
    const q = await norm("tube 110 blnc");
    expect(q.normalized).toBe("tube 110 blanc");
    expect(q.corrections).toContainEqual(expect.objectContaining({ from: "blnc", to: "blanc", kind: "typo" }));
    expect(q.attributeValues["color"]).toBe("blanc");
    expect(q.attributes["color"]!.provenance).toBe("inferred");
    expect(q.attributes["color"]!.rule).toBe("color:vocabulary-after-typo");
  });

  it("typo: blan stays ambiguous? -> blanc wins uniquely over base vocab", async () => {
    // with the shipped dictionary, "blan" is distance-1 from both "blanc" (insert c)
    // and "blanche" is distance-2; unique winner expected
    const q = await norm("tube blan");
    expect(q.normalized).toBe("tube blanc");
  });

  it("typo: evacuaton -> evacuation, racord -> raccord", async () => {
    expect((await norm("tube evacuaton pvc")).normalized).toBe("tube evacuation pvc");
    expect((await norm("racord pvc 110")).normalized).toBe("raccord pvc 110");
  });

  it("abbreviation: Ø110 / DN110 / D110 / dia110 / diam 110 -> diameter attribute", async () => {
    for (const raw of ["Ø110", "DN110", "D110", "dia110", "diam 110", "dia 110"]) {
      const q = await norm(`tube ${raw}`);
      expect(q.attributeValues["diameter"], `case ${raw}`).toBe("110");
      expect(q.attributes["diameter"]!.provenance).toBe("observed");
    }
    // with mm unit
    const q = await norm("tube Ø110 mm");
    expect(q.attributeValues["diameter"]).toBe("110 mm");
  });

  it("unit canonicalization: Ø11 cm / Ø0.11 m -> 110 mm (flagged inferred)", async () => {
    const cm = await norm("tube Ø11cm");
    expect(cm.attributeValues["diameter"]).toBe("110 mm");
    expect(cm.attributes["diameter"]!.provenance).toBe("inferred");
    expect(cm.attributes["diameter"]!.rule).toContain("unit-convert");

    const m = await norm("tube Ø0.11m");
    expect(m.attributeValues["diameter"]).toBe("110 mm");
  });

  it("bare numbers are NOT turned into attributes (no invention)", async () => {
    const q = await norm("tube 110");
    expect(q.attributes).toEqual({});
    expect(q.normalized).toBe("tube 110");
    expect(q.tokens).toContain("110");
  });

  it("bare '110mm' is NOT turned into a diameter attribute (no dimension keyword)", async () => {
    const q = await norm("tube 110mm");
    expect(q.attributes["diameter"]).toBeUndefined();
    expect(q.tokens).toContain("110");
    expect(q.tokens).toContain("mm");
  });

  it("dimension composites keep order and stay composites", async () => {
    const q = await norm("goulotte 110x45");
    expect(q.tokens).toContain("110x45");
    expect(q.tokens).toContain("110");
    expect(q.tokens).toContain("45");
    const reversed = await norm("goulotte 45x110");
    expect(reversed.tokens).toContain("45x110");
    expect(reversed.tokens).not.toContain("110x45");
  });

  it("color: tube 110 blanc -> color attribute", async () => {
    const q = await norm("tube 110 blanc");
    expect(q.attributeValues["color"]).toBe("blanc");
  });

  it("material: tube pvc -> material attribute", async () => {
    const q = await norm("tube pvc");
    expect(q.attributeValues["material"]).toBe("PVC");
  });

  it("synonym: assainissement expands to evacuation (both directions)", async () => {
    const q = await norm("tube assainissement");
    expect(q.tokens).toContain("assainissement");
    expect(q.tokens).toContain("evacuation");
    expect(q.corrections).toContainEqual(expect.objectContaining({ kind: "synonym" }));
    const q2 = await norm("tube évacuation");
    expect(q2.tokens).toContain("assainissement");
  });

  it("product codes: T110B45 / T-110-B45 / ABC 123", async () => {
    expect((await norm("T110B45")).codes).toEqual(["T110B45"]);
    expect((await norm("t110b45")).codes).toEqual(["T110B45"]);
    expect((await norm("T-110-B45")).codes).toEqual(["T110B45"]);
    expect((await norm("ABC 123")).codes).toEqual(["ABC123"]);
    // lowercase words followed by numbers are NOT codes
    expect((await norm("tube 110")).codes).toEqual([]);
  });

  it("never typo-corrects code-shaped tokens", async () => {
    const q = await norm("T110B45");
    expect(q.corrections).toEqual([]);
    expect(q.normalized).toBe("T110B45");
  });

  it("mixed query: tube pvc 110 blanc 4m", async () => {
    const q = await norm("tube pvc 110 blanc 4m");
    expect(q.attributeValues).toEqual({ material: "PVC", color: "blanc" });
    expect(q.tokens).toContain("4");
    expect(q.tokens).toContain("m");
    expect(q.normalized).toBe("tube pvc 110 blanc 4m");
  });

  it("accents and case are folded in tokens but normalized keeps French", async () => {
    const q = await norm("Tube Évacuation PVC");
    expect(q.tokens).toContain("evacuation");
    expect(q.tokens).toContain("pvc");
    expect(q.normalized).toBe("tube évacuation pvc");
  });

  it("empty and whitespace queries", async () => {
    expect((await norm("")).isEmpty).toBe(true);
    expect((await norm("   ")).isEmpty).toBe(true);
  });

  it("unicode, punctuation, multiple spaces, hyphens, slashes, decimals", async () => {
    const q = await norm("  tube   - PVC/PPR,  Ø110 : 2,5 kg ");
    expect(q.isEmpty).toBe(false);
    expect(q.attributeValues["material"]).toBe("PVC");
    expect(q.attributeValues["diameter"]).toBe("110");
    expect(q.tokens).toContain("2.5");
    expect(q.tokens).toContain("kg");
  });

  it("very long queries do not crash", async () => {
    const long = "tube ".repeat(500);
    const q = await norm(long);
    expect(q.normalized.length).toBeGreaterThan(0);
  });

  it("provenance distinguishes observed / normalized / inferred / unknown", async () => {
    const q = await norm("tube blnc xyzzyq");
    expect(q.tokenProvenance["tube"]).toBe("observed");
    expect(q.tokenProvenance["blanc"]).toBe("normalized");
    expect(q.tokenProvenance["evacuation"] ?? q.tokenProvenance["blanc"]).toBeDefined();
    expect(q.tokenProvenance["xyzzyq"]).toBe("unknown");
  });

  it("vocabulary from the catalog participates in typo correction", async () => {
    // "plombrie" is not in the shipped base vocabulary, only in the catalog
    const q = await norm("plombri", ["plombrie"]);
    expect(q.normalized).toBe("plombrie");
    expect(q.corrections).toContainEqual(expect.objectContaining({ from: "plombri", to: "plombrie", kind: "typo" }));
  });

  it("deterministic: identical input -> identical output", async () => {
    const a = await norm("tube 110 blnc pvc");
    const b = await norm("tube 110 blnc pvc");
    expect(a).toEqual(b);
  });
});

describe("DeterministicNormalizer assembly", () => {
  it("exposes attributeValues as flat map (spec §5 shape)", async () => {
    const q = await norm("tube Ø110 blanc");
    expect(q.attributeValues).toEqual({ diameter: "110", color: "blanc" });
  });

  it("spec example: 'tube 110 blnc' normalizes conservatively", async () => {
    const q = await norm("tube 110 blnc");
    expect(q.original).toBe("tube 110 blnc");
    expect(q.normalized).toBe("tube 110 blanc");
    expect(q.tokens).toContain("tube");
    expect(q.tokens).toContain("110");
    expect(q.tokens).toContain("blanc");
    // critical: no invented PVC/évacuation/4m
    expect(q.attributes["material"]).toBeUndefined();
    expect(q.attributes["length"]).toBeUndefined();
  });
});

describe("MockNormalizer", () => {
  it("applies scripted replacements and attributes", async () => {
    const mock = new MockNormalizer({ "tbe 110": "tube 110" }, { color: "blanc" });
    const q = await mock.normalize("tbe 110");
    expect(q.normalized).toBe("tube 110");
    expect(q.attributeValues["color"]).toBe("blanc");
  });
});
