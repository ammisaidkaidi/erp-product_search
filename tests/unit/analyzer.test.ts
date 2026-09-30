import { describe, expect, it } from "vitest";
import { analyzeCode, analyzeText, canonicalCode, foldText, isCodeShaped, preprocessText } from "../../src/analysis/analyzer.js";

function terms(input: string): string[] {
  return analyzeText(input).map((t) => t.term);
}

describe("foldText", () => {
  it("folds accents, case and special letters", () => {
    expect(foldText("Évacuation")).toBe("evacuation");
    expect(foldText("Ø110")).toBe("o110");
    expect(foldText("Œuvre")).toBe("oeuvre");
  });
});

describe("canonicalCode", () => {
  it("uppercases and strips separators", () => {
    expect(canonicalCode("T-110-B45")).toBe("T110B45");
    expect(canonicalCode("t110b45")).toBe("T110B45");
    expect(canonicalCode("ABC 123")).toBe("ABC123");
  });
});

describe("isCodeShaped", () => {
  it("detects mixed letter/digit tokens", () => {
    expect(isCodeShaped("T110B45")).toBe(true);
    expect(isCodeShaped("ABC123")).toBe(true);
    expect(isCodeShaped("tube")).toBe(false);
    expect(isCodeShaped("110")).toBe(false);
    expect(isCodeShaped("blanc")).toBe(false);
  });
});

describe("preprocessText", () => {
  it("rewrites diameter symbols", () => {
    expect(preprocessText("Ø110")).toBe("dia 110");
    expect(preprocessText("⌀ 110")).toBe("dia 110");
    expect(preprocessText("DN110")).toBe("dia 110");
    expect(preprocessText("D110")).toBe("dia 110");
    expect(preprocessText("diam 110")).toContain("diam");
  });

  it("canonicalizes dimension expressions while preserving order", () => {
    expect(preprocessText("110x45")).toBe("110x45");
    expect(preprocessText("110 x 45")).toBe("110x45");
    expect(preprocessText("110*45")).toBe("110x45");
    expect(preprocessText("110/45")).toBe("110x45");
    expect(preprocessText("110X45")).toBe("110x45");
    // order must NOT be swapped: 45x110 stays 45x110
    expect(preprocessText("45 x 110")).toBe("45x110");
  });

  it("does not rewrite letter slashes (PVC/PPR)", () => {
    expect(preprocessText("PVC/PPR")).toBe("PVC/PPR");
  });
});

describe("analyzeText", () => {
  it("splits attached units: 110mm -> 110 + mm", () => {
    expect(terms("110mm")).toEqual(["110", "mm"]);
    expect(terms("4m")).toEqual(["4", "m"]);
  });

  it("emits composite + parts for dimensions", () => {
    expect(terms("110x45")).toEqual(["110x45", "110", "45"]);
    expect(terms("110 x 45")).toEqual(["110x45", "110", "45"]);
  });

  it("canonicalizes decimal commas", () => {
    expect(terms("2,5 kg")).toEqual(["2.5", "kg"]);
  });

  it("handles French apostrophes and punctuation", () => {
    const t = terms("Tube d'évacuation - PVC, blanc !");
    expect(t).toContain("tube");
    expect(t).toContain("evacuation");
    expect(t).toContain("pvc");
    expect(t).toContain("blanc");
  });

  it("adds singular variants for plurals", () => {
    const t = analyzeText("tubes raccords");
    expect(t.map((x) => x.term)).toContain("tube");
    expect(t.map((x) => x.term)).toContain("raccord");
    // short words are not singularized
    const t2 = analyzeText("des");
    expect(t2.map((x) => x.term)).toEqual(["des"]);
  });

  it("handles unicode edge cases: null bytes, emojis, CJK", () => {
    expect(terms("\u0000tube\u0000")).toContain("tube");
    expect(terms("tube 🔧 pvc")).toContain("pvc");
    expect(terms("水泥")).toEqual(["水泥"]);
  });

  it("empty and whitespace-only inputs produce no tokens", () => {
    expect(terms("")).toEqual([]);
    expect(terms("   ")).toEqual([]);
    expect(terms(".,-|/")).toEqual([]);
  });
});

describe("analyzeCode", () => {
  it("produces canonical + boundary parts", () => {
    const t = analyzeCode("T-110-B45").map((x) => x.term);
    expect(t).toContain("t110b45");
    expect(t).toContain("110");
    expect(t).toContain("45");
    expect(t).toContain("t");
    expect(t).toContain("b");
  });
});
