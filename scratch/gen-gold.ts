/**
 * Generates fixtures/gold-fr.jsonl from explicit relevance predicates.
 *
 * The fixture gold set is machine-derived (deterministic predicates over the
 * generated catalog) so labels are verifiable; real production gold sets are
 * human-labeled in the SAME format:
 *   {"query": "...", "productId": "P000123", "label": 3}   # 0-4 scale
 *
 * Regenerate: npx tsx scratch/gen-gold.ts
 */
import { generateFixtureCatalog } from "../src/benchmark/catalog-generator.js";
import { writeFileSync } from "node:fs";

type Product = ReturnType<typeof generateFixtureCatalog>[number];

interface GoldRule {
  query: string;
  labels: Array<{ match: (p: Product) => boolean; label: number }>;
}

const rules: GoldRule[] = [
  {
    query: "tube 110 blanc",
    labels: [
      { match: (p) => p.name.includes("Tube") && p.attributes["diameter"] === "110 mm" && p.attributes["color"] === "blanc", label: 4 },
      { match: (p) => p.name.includes("Tube") && p.attributes["diameter"] === "110 mm" && p.attributes["color"] === "gris", label: 2 },
      { match: (p) => p.name.includes("Tube") && p.attributes["diameter"] === "110 mm", label: 2 },
    ],
  },
  { query: "tube 110 blnc", labels: [] }, // filled below by aliasing
  {
    query: "tube évacuation 110",
    labels: [
      { match: (p) => p.name.includes("évacuation") && p.attributes["diameter"] === "110 mm", label: 4 },
      { match: (p) => p.name.includes("évacuation"), label: 2 },
    ],
  },
  {
    query: "TD110L4BL0",
    labels: [{ match: (p) => p.code === "TD110L4BL0", label: 4 }],
  },
  {
    query: "tube assainissement 160",
    labels: [
      { match: (p) => p.name.includes("assainissement") && p.attributes["diameter"] === "160 mm", label: 4 },
      { match: (p) => p.name.includes("évacuation") && p.attributes["diameter"] === "160 mm", label: 2 },
    ],
  },
  {
    query: "Ø110",
    labels: [
      { match: (p) => p.name.includes("Tube") && p.attributes["diameter"] === "110 mm", label: 3 },
      { match: (p) => p.attributes["diameter"] === "110 mm", label: 2 },
    ],
  },
  {
    query: "DN110",
    labels: [
      { match: (p) => p.name.includes("Tube") && p.attributes["diameter"] === "110 mm", label: 3 },
      { match: (p) => p.attributes["diameter"] === "110 mm", label: 2 },
    ],
  },
  {
    query: "tube 110mm",
    labels: [{ match: (p) => p.name.includes("Tube") && p.attributes["diameter"] === "110 mm", label: 4 }],
  },
  {
    query: "raccord à bague 110 blanc",
    labels: [{ match: (p) => p.name.includes("bague") && p.attributes["diameter"] === "110 mm", label: 4 }],
  },
  {
    query: "coude 125",
    labels: [{ match: (p) => p.name.includes("Coude") && p.attributes["diameter"] === "125 mm", label: 4 }],
  },
  {
    query: "té pvc 63",
    labels: [{ match: (p) => p.name.includes("Té") && p.attributes["diameter"] === "63 mm", label: 4 }],
  },
  {
    query: "câble rigide 2.5",
    labels: [
      { match: (p) => p.name.includes("rigide") && p.attributes["section"] === "2.5 mm²", label: 4 },
      { match: (p) => p.name.includes("rigide"), label: 2 },
    ],
  },
  {
    query: "cable souple 1.5 noir",
    labels: [
      { match: (p) => p.name.includes("souple") && p.attributes["section"] === "1.5 mm²" && p.attributes["color"] === "noir", label: 4 },
      { match: (p) => p.name.includes("souple") && p.attributes["section"] === "1.5 mm²", label: 2 },
    ],
  },
  {
    query: "gaine icta 32",
    labels: [{ match: (p) => p.name.includes("ICTA") && p.attributes["diameter"] === "32 mm", label: 4 }],
  },
  {
    query: "gaine icta 40 gris",
    labels: [
      { match: (p) => p.name.includes("ICTA") && p.attributes["diameter"] === "40 mm" && p.attributes["color"] === "gris", label: 4 },
      { match: (p) => p.name.includes("ICTA") && p.attributes["diameter"] === "40 mm", label: 2 },
    ],
  },
  {
    query: "vanne d'arrêt laiton 50",
    labels: [
      { match: (p) => p.name.includes("arrêt") && p.attributes["diameter"] === "50 mm", label: 4 },
      { match: (p) => p.name.includes("Vanne") && p.attributes["diameter"] === "50 mm", label: 2 },
    ],
  },
  {
    query: "vanne papillon 110",
    labels: [{ match: (p) => p.name.includes("papillon") && p.attributes["diameter"] === "110 mm", label: 4 }],
  },
  {
    query: "tube ppr 32",
    labels: [
      { match: (p) => p.attributes["material"] === "PPR" && p.attributes["diameter"] === "32 mm", label: 4 },
      { match: (p) => p.name.includes("Tube") && p.attributes["diameter"] === "32 mm", label: 2 },
    ],
  },
  {
    query: "tube pehd 25 bleu",
    labels: [
      { match: (p) => p.name.includes("PEHD") && p.attributes["diameter"] === "25 mm" && p.attributes["color"] === "bleu", label: 4 },
      { match: (p) => p.name.includes("PEHD") && p.attributes["diameter"] === "25 mm", label: 2 },
    ],
  },
  {
    query: "tube drainage 50",
    labels: [{ match: (p) => p.name.includes("drainage") && p.attributes["diameter"] === "50 mm", label: 4 }],
  },
  {
    query: "tube 160 gris",
    labels: [
      { match: (p) => p.name.includes("Tube") && p.attributes["diameter"] === "160 mm" && p.attributes["color"] === "gris", label: 4 },
      { match: (p) => p.name.includes("Tube") && p.attributes["diameter"] === "160 mm", label: 2 },
    ],
  },
  {
    query: "raccord pvc 100",
    labels: [
      { match: (p) => !p.name.includes("Tube") && !p.name.includes("Vanne") && !p.name.includes("Câble") && !p.name.includes("Gaine") && p.attributes["diameter"] === "100 mm" && p.attributes["material"] === "PVC", label: 4 },
    ],
  },
  {
    query: "chemin de câbles 20",
    labels: [
      { match: (p) => p.name.includes("Chemins") && p.attributes["diameter"] === "20 mm", label: 4 },
      { match: (p) => p.name.includes("Chemins"), label: 2 },
    ],
  },
  {
    query: "tube evacuation 4m",
    labels: [
      { match: (p) => p.name.includes("évacuation") && p.attributes["length"] === "4 m", label: 4 },
      { match: (p) => p.name.includes("évacuation"), label: 1 },
    ],
  },
  {
    query: "tube 63 6m orange",
    labels: [
      { match: (p) => p.name.includes("Tube") && p.attributes["diameter"] === "63 mm" && p.attributes["length"] === "6 m" && p.attributes["color"] === "orange", label: 4 },
      { match: (p) => p.name.includes("Tube") && p.attributes["diameter"] === "63 mm" && p.attributes["color"] === "orange", label: 2 },
    ],
  },
  {
    query: "manchon pvc 80",
    labels: [{ match: (p) => p.name.includes("Manchon") && p.attributes["diameter"] === "80 mm", label: 4 }],
  },
  {
    query: "réduction 125",
    labels: [{ match: (p) => p.name.includes("Réduction") && p.attributes["diameter"] === "125 mm", label: 4 }],
  },
  {
    query: "câble 6mm",
    labels: [
      { match: (p) => p.name.includes("Câble") && p.attributes["section"] === "6 mm²", label: 4 },
      { match: (p) => p.name.includes("Câble"), label: 1 },
    ],
  },
  {
    query: "gaine noire 20",
    labels: [
      { match: (p) => p.name.includes("Gaine") && p.attributes["diameter"] === "20 mm" && p.attributes["color"] === "noir", label: 4 },
      { match: (p) => p.name.includes("Gaine") && p.attributes["diameter"] === "20 mm", label: 2 },
    ],
  },
  {
    query: "robinet flotteur",
    labels: [{ match: (p) => p.name.includes("flotteur"), label: 4 }],
  },
  {
    query: "tube souple 100m",
    labels: [], // alias-free: filled below (câble souple 100m)
  },
];

const catalog = generateFixtureCatalog();
const lines: string[] = [];

for (const rule of rules) {
  if (rule.labels.length === 0) continue; // aliases handled below
  const labeled = new Map<string, number>();
  for (const { match, label } of rule.labels) {
    for (const product of catalog) {
      if (match(product)) {
        const existing = labeled.get(product.id);
        if (existing === undefined || label > existing) {
          labeled.set(product.id, label);
        }
      }
    }
  }
  for (const [productId, label] of labeled) {
    lines.push(JSON.stringify({ query: rule.query, productId, label }));
  }
}

// typo-variant query shares the labels of its canonical form
const alias = rules.find((r) => r.query === "tube 110 blanc")!;
const canonicalLabels = lines.filter((l) => JSON.parse(l).query === alias.query);
for (const line of canonicalLabels) {
  const record = JSON.parse(line) as { productId: string; label: number };
  lines.push(JSON.stringify({ query: "tube 110 blnc", productId: record.productId, label: record.label }));
}

writeFileSync("fixtures/gold-fr.jsonl", lines.join("\n") + "\n");

// summary
const queries = new Set(lines.map((l) => (JSON.parse(l) as { query: string }).query));
console.log(`gold-fr.jsonl: ${lines.length} labels across ${queries.size} queries`);
