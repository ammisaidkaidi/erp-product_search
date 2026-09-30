import type { Product } from "../core/types.js";

/**
 * Deterministic synthetic catalog generator for benchmarks and fixtures.
 *
 * The vocabulary mirrors a French building-materials ERP (plumbing, electrical,
 * tools) so generated catalogs exercise the same analyzer paths as real data:
 * product codes, dimensions (Ø), colors, materials, brands, categories.
 *
 * Output is a pure function of (size, seed): same inputs => same catalog.
 */

/** mulberry32 — tiny deterministic PRNG */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FAMILIES = [
  {
    category: "Plomberie",
    subcategory: "Évacuation",
    kind: "tube",
    names: ["Tube PVC évacuation", "Tube PVC assainissement", "Tube PVC drainage"],
    diameters: [32, 40, 50, 63, 80, 100, 110, 125, 160, 200],
    colors: ["blanc", "gris", "orange"],
    lengths: [2, 4, 6],
    materials: ["PVC"],
    codePrefix: "T",
  },
  {
    category: "Plomberie",
    subcategory: "Pression",
    kind: "tube",
    names: ["Tube PPR pression", "Tube PER", "Tube PEHD assainissement"],
    diameters: [16, 20, 25, 32, 40, 50, 63],
    colors: ["blanc", "gris", "bleu", "noir"],
    lengths: [2, 4, 6],
    materials: ["PPR", "PER", "PEHD"],
    codePrefix: "TP",
  },
  {
    category: "Plomberie",
    subcategory: "Raccords",
    kind: "raccord",
    names: ["Coude PVC 90°", "Manchon PVC", "Té PVC", "Réduction PVC", "Raccord à bague PVC"],
    diameters: [32, 40, 50, 63, 80, 100, 110, 125],
    colors: ["blanc", "gris"],
    lengths: [],
    materials: ["PVC", "PPR"],
    codePrefix: "R",
  },
  {
    category: "Plomberie",
    subcategory: "Robinetterie",
    kind: "vanne",
    names: ["Vanne à boisseau PVC", "Robinet à flotteur", "Vanne d'arrêt laiton", "Vanne à papillon PVC"],
    diameters: [20, 25, 32, 40, 50, 63, 110],
    colors: ["bleu", "gris", "chromé"],
    lengths: [],
    materials: ["PVC", "laiton"],
    codePrefix: "V",
  },
  {
    category: "Électricité",
    subcategory: "Câbles",
    kind: "cable",
    names: ["Câble rigide H07V-U", "Câble souple H05V-F", "Câble rigide 3G", "Câble souple 5G"],
    sections: ["1.5 mm²", "2.5 mm²", "4 mm²", "6 mm²"],
    colors: ["bleu", "rouge", "vert", "jaune", "noir", "gris"],
    lengths: [25, 50, 100],
    materials: ["cuivre"],
    codePrefix: "C",
  },
  {
    category: "Électricité",
    subcategory: "Gaines",
    kind: "gaine",
    names: ["Gaine ICTA", "Goulotte PVC", "Gaine TPC", "Chemins de câbles"],
    diameters: [16, 20, 25, 32, 40],
    colors: ["noir", "gris", "blanc"],
    lengths: [25, 50, 100],
    materials: ["PVC", "PE"],
    codePrefix: "G",
  },
  {
    category: "Matériaux",
    subcategory: "Étanchéité",
    kind: "joint",
    names: ["Joint caoutchouc", "Joint plat fibre", "Colle PVC", "Mastic sanitaire", "Ruban étanche"],
    colors: ["noir", "blanc", "gris"],
    materials: ["caoutchouc", "PVC", "silicone"],
    codePrefix: "J",
  },
  {
    category: "Outillage",
    subcategory: "Soudure",
    kind: "tool",
    names: ["Poste à souder", "Chalumeau gaz", "Buse de rechange", "Poste à souder MIG"],
    powers: ["120 W", "400 W", "1.5 kW", "3 kW"],
    colors: ["bleu", "noir", "rouge"],
    materials: [],
    codePrefix: "S",
  },
] as const;

const BRANDS = ["Somaterial", "PlumboPro", "ElecMax", "TechnoFix", "BatiPlus", "AquaLine"];

export interface GenerateCatalogOptions {
  size: number;
  seed?: number;
  /** id prefix (default P) */
  idPrefix?: string;
}

export function generateCatalog(options: GenerateCatalogOptions): Product[] {
  const { size } = options;
  const seed = options.seed ?? 42;
  const rng = mulberry32(seed);
  const idPrefix = options.idPrefix ?? "P";
  const products: Product[] = [];

  const seenCodes = new Set<string>();

  for (let i = 0; i < size; i++) {
    const family = FAMILIES[i % FAMILIES.length]!;
    const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)]!;
    const name = pick(family.names);
    const color = pick(family.colors);
    const brand = pick(BRANDS);

    const attributes: Record<string, string> = { color };
    let codeSuffix = "";

    if ("diameters" in family && family.diameters.length > 0) {
      const diameter = pick(family.diameters);
      attributes["diameter"] = `${diameter} mm`;
      codeSuffix += `D${diameter}`;
    }
    if ("lengths" in family && family.lengths.length > 0 && family.lengths[0] !== undefined) {
      const length = pick(family.lengths);
      attributes["length"] = `${length} m`;
      codeSuffix += `L${length}`;
    }
    if ("sections" in family) {
      attributes["section"] = pick(family.sections);
      codeSuffix += `S${attributes["section"]!.replace(/[^0-9.]/g, "")}`;
    }
    if ("powers" in family) {
      attributes["power"] = pick(family.powers);
      codeSuffix += `W${attributes["power"]!.replace(/[^0-9.]/g, "")}`;
    }
    if (family.materials.length > 0) {
      attributes["material"] = pick(family.materials);
    }

    let code = `${family.codePrefix}${codeSuffix}${color.slice(0, 2).toUpperCase()}${i}`;
    while (seenCodes.has(code)) code = `${code}X`;
    seenCodes.add(code);

    products.push({
      id: `${idPrefix}${String(i + 1).padStart(6, "0")}`,
      code,
      name,
      attributes,
      brand,
      category: family.category,
      subcategory: family.subcategory,
    });
  }
  return products;
}

/** Small deterministic fixture catalog (~200 products) for tests and demos. */
export function generateFixtureCatalog(): Product[] {
  return generateCatalog({ size: 200, seed: 7 });
}
