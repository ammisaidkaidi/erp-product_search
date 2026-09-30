import { generateFixtureCatalog } from "../src/benchmark/catalog-generator.js";
const catalog = generateFixtureCatalog();
const show = (label: string, pred: (p: typeof catalog[0]) => boolean) => {
  console.log(`\n## ${label}`);
  for (const p of catalog.filter(pred)) console.log(p.id, p.code, p.name, JSON.stringify(p.attributes));
};
show("evacuation tubes (name contains évacuation)", (p) => p.name.includes("évacuation"));
show("assainissement tubes", (p) => p.name.includes("assainissement"));
show("tubes diameter 110", (p) => p.attributes["diameter"] === "110 mm" && p.name.includes("Tube"));
show("tubes diameter 110 blanc", (p) => p.attributes["diameter"] === "110 mm" && p.attributes["color"] === "blanc");
show("gaine icta", (p) => p.name.includes("ICTA"));
show("vannes", (p) => p.name.includes("Vanne"));
show("colle/mastic", (p) => p.name.includes("Colle") || p.name.includes("Mastic"));
show("poste souder", (p) => p.name.includes("souder"));
