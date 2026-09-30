/**
 * French domain dictionary (DATA ONLY — loaded by the composition root).
 *
 * Everything language-specific lives here: colors, materials, abbreviations,
 * synonyms, dimension keywords and unit factors. Adding a language means
 * writing another dictionary + LanguageNormalizer; the engine never changes.
 *
 * Keys and words are stored FOLDED (lowercase, accentless) — matching happens
 * on folded tokens; canonical values keep proper French spelling.
 */

export interface LanguageDictionary {
  language: string;
  /** folded color word -> canonical color ("blanc" -> "blanc") */
  colors: Record<string, string>;
  /** folded material word -> canonical material ("pvc" -> "PVC", "cuivre" -> "cuivre") */
  materials: Record<string, string>;
  /** folded abbreviation -> expansion ("dia" -> "diamètre") */
  abbreviations: Record<string, string>;
  /** synonym groups (folded): every member is searchable for all members */
  synonyms: string[][];
  /** tokens that introduce a dimension context */
  diameterKeywords: string[];
  lengthKeywords: string[];
  widthKeywords: string[];
  /** unit -> millimeters factor (length units only) */
  unitFactors: Record<string, number>;
  /** canonical attribute names usable by extraction rules (whitelist for LLM output too) */
  knownAttributeNames: string[];
  /** common words worth typo-correcting even without catalog vocabulary */
  baseVocabulary: string[];
}

export const FRENCH_DICTIONARY: LanguageDictionary = {
  language: "fr",
  colors: {
    blanc: "blanc",
    blanche: "blanc",
    blancs: "blanc",
    gris: "gris",
    grise: "gris",
    anthracite: "anthracite",
    bleu: "bleu",
    rouge: "rouge",
    noir: "noir",
    noire: "noir",
    vert: "vert",
    verte: "vert",
    jaune: "jaune",
    orange: "orange",
    beige: "beige",
    brun: "brun",
    marron: "marron",
    transparent: "transparent",
    argent: "argent",
    chrome: "chromé",
  },
  materials: {
    pvc: "PVC",
    pe: "PE",
    pehd: "PEHD",
    pp: "PP",
    ppr: "PPR",
    per: "PER",
    cuivre: "cuivre",
    cu: "cuivre",
    laiton: "laiton",
    inox: "inox",
    acier: "acier",
    fonte: "fonte",
    plastique: "plastique",
    beton: "béton",
    caoutchouc: "caoutchouc",
    polyethylene: "polyéthylène",
  },
  abbreviations: {
    dia: "diamètre",
    diam: "diamètre",
    dn: "diamètre",
    ø: "diamètre",
    lg: "longueur",
    long: "longueur",
    larg: "largeur",
    evac: "évacuation",
    assain: "assainissement",
  },
  synonyms: [
    // true search-equivalents in the plumbing/materials domain
    ["evacuation", "assainissement"],
    ["tuyau", "tube"],
  ],
  diameterKeywords: ["diametre", "dia", "diam", "dn", "ø"],
  lengthKeywords: ["longueur", "lg", "long"],
  widthKeywords: ["largeur", "larg"],
  unitFactors: { mm: 1, cm: 10, dm: 100, m: 1000 },
  knownAttributeNames: [
    "diameter",
    "length",
    "width",
    "color",
    "material",
    "section",
    "height",
    "weight",
    "pressure",
    "power",
    "thread",
  ],
  baseVocabulary: [
    "tube",
    "tuyau",
    "raccord",
    "coude",
    "manchon",
    "vanne",
    "robinet",
    "cable",
    "gaine",
    "colle",
    "joint",
    "bague",
    "ecrou",
    "reduction",
    "bouchon",
    "goulotte",
    "evacuation",
    "assainissement",
    "blanc",
    "gris",
    "noir",
    "bleu",
    "rouge",
    "vert",
    "jaune",
    "flexible",
    "rigide",
    "diametre",
    "longueur",
    "largeur",
    "chantier",
  ],
};
