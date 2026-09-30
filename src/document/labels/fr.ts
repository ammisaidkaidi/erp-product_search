/**
 * French attribute labels. Data only — loaded by the composition root, never
 * imported by core engine code. Additional languages can provide their own map.
 */
export const FRENCH_ATTRIBUTE_LABELS: Readonly<Record<string, string>> = {
  diameter: "diamètre",
  diameter_mm: "diamètre",
  diameter_cm: "diamètre",
  length: "longueur",
  width: "largeur",
  height: "hauteur",
  depth: "profondeur",
  thickness: "épaisseur",
  weight: "poids",
  color: "couleur",
  colour: "couleur",
  material: "matière",
  brand: "marque",
  model: "modèle",
  power: "puissance",
  voltage: "tension",
  current: "intensité",
  frequency: "fréquence",
  pressure: "pression",
  temperature: "température",
  capacity: "capacité",
  volume: "volume",
  thread: "filetage",
  finish: "finition",
  density: "densité",
  flow_rate: "débit",
  size: "taille",
  pack_quantity: "quantité par paquet",
  norm: "norme",
  usage: "usage",
  type: "type",
  gender: "genre",
  thread_size: "dimension filetage",
  length_m: "longueur",
  rating: "classe",
};

/** Humanize an unknown attribute key as a deterministic fallback label. */
export function humanizeKey(key: string): string {
  return key.replace(/[_-]+/g, " ").trim() || key;
}
