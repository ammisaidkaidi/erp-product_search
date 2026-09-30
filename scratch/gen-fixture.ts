import { generateFixtureCatalog } from "../src/benchmark/catalog-generator.js";
import { writeFileSync } from "node:fs";
const catalog = generateFixtureCatalog();
writeFileSync("fixtures/catalog-fr.json", JSON.stringify(catalog, null, 2));
for (const p of catalog.filter((p) => p.code.startsWith("T")).slice(0, 26)) {
  console.log(p.id, p.code, "|", p.name, "|", JSON.stringify(p.attributes));
}
console.log("--- raccords");
for (const p of catalog.filter((p) => p.code.startsWith("R")).slice(0, 8)) {
  console.log(p.id, p.code, "|", p.name, "|", JSON.stringify(p.attributes));
}
console.log("--- cables");
for (const p of catalog.filter((p) => p.code.startsWith("C")).slice(0, 8)) {
  console.log(p.id, p.code, "|", p.name, "|", JSON.stringify(p.attributes));
}
console.log("--- vannes/gaines");
for (const p of catalog.filter((p) => ["V", "G"].includes(p.code[0]!)).slice(0, 10)) {
  console.log(p.id, p.code, "|", p.name, "|", JSON.stringify(p.attributes));
}
