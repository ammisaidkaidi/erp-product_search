import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import type { Product } from "../core/types.js";
import { StoreError } from "../core/errors.js";

/**
 * Source of raw ERP products for (re)indexing. The search system NEVER writes
 * to the ERP; it only reads through this interface. Real deployments implement
 * this against their own schema; JSON catalog + PG table providers ship built-in.
 */
export interface ProductProvider {
  readonly id: string;
  fetchAll(): AsyncIterable<Product>;
  fetch(ids: string[]): Promise<Product[]>;
}

/** Provider over a JSON file (fixtures, exports, small catalogs). */
export class JsonCatalogProvider implements ProductProvider {
  readonly id: string;
  private readonly file: string;

  constructor(file: string, id = "json") {
    this.file = file;
    this.id = id;
  }

  async *fetchAll(): AsyncIterable<Product> {
    const raw = await readFile(this.file, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new StoreError(`Catalog file ${this.file} must be a JSON array`);
    for (const item of parsed) {
      yield parseProduct(item);
    }
  }

  async fetch(ids: string[]): Promise<Product[]> {
    const wanted = new Set(ids);
    const out: Product[] = [];
    for await (const product of this.fetchAll()) {
      if (wanted.has(product.id)) out.push(product);
    }
    return out;
  }
}

/** In-memory provider (tests, benchmarks). */
export class StaticProductProvider implements ProductProvider {
  readonly id = "static";
  constructor(private readonly products: Product[]) {}
  async *fetchAll(): AsyncIterable<Product> {
    for (const p of this.products) yield p;
  }
  async fetch(ids: string[]): Promise<Product[]> {
    const wanted = new Set(ids);
    return this.products.filter((p) => wanted.has(p.id));
  }
}

/**
 * Provider over a PostgreSQL products table (ERP-side). Expected columns:
 *   id TEXT PK, code TEXT, name TEXT, attributes JSONB,
 *   brand TEXT NULL, category TEXT NULL, subcategory TEXT NULL
 * Adjust the SQL in a custom provider if the ERP schema differs.
 */
export class PgProductProvider implements ProductProvider {
  readonly id = "pg-products";
  constructor(
    private readonly pool: Pool,
    private readonly table = "products",
  ) {}

  async *fetchAll(batchSize = 500): AsyncIterable<Product> {
    let cursor: string | null = null;
    for (;;) {
      const result: { rows: Array<Record<string, unknown>> } = await this.pool.query(
        `SELECT id, code, name, attributes, brand, category, subcategory FROM ${this.table}
         WHERE ($1::text IS NULL OR id > $1) ORDER BY id ASC LIMIT $2`,
        [cursor, batchSize],
      );
      if (result.rows.length === 0) return;
      for (const row of result.rows) {
        yield this.toProduct(row);
      }
      cursor = String(result.rows[result.rows.length - 1]!.id);
    }
  }

  async fetch(ids: string[]): Promise<Product[]> {
    if (ids.length === 0) return [];
    const result: { rows: Array<Record<string, unknown>> } = await this.pool.query(
      `SELECT id, code, name, attributes, brand, category, subcategory FROM ${this.table}
       WHERE id = ANY($1::text[])`,
      [ids],
    );
    return result.rows.map((row) => this.toProduct(row));
  }

  private toProduct(row: Record<string, unknown>): Product {
    const str = (key: string): string | undefined =>
      typeof row[key] === "string" && (row[key] as string).length > 0 ? (row[key] as string) : undefined;
    return {
      id: String(row.id),
      code: str("code") ?? "",
      name: str("name") ?? "",
      attributes: (row.attributes ?? {}) as Record<string, string>,
      brand: str("brand"),
      category: str("category"),
      subcategory: str("subcategory"),
    };
  }
}

/** Defensive parsing of external product JSON (untrusted data). */
export function parseProduct(item: unknown): Product {
  if (typeof item !== "object" || item === null) {
    throw new StoreError("Catalog entry is not an object");
  }
  const rec = item as Record<string, unknown>;
  if (typeof rec.id !== "string" || rec.id.length === 0) {
    throw new StoreError("Catalog entry missing string 'id'");
  }
  const attributes: Record<string, string> = {};
  if (rec.attributes !== undefined && rec.attributes !== null) {
    if (typeof rec.attributes !== "object") throw new StoreError(`Product ${rec.id}: attributes must be an object`);
    for (const [k, v] of Object.entries(rec.attributes as Record<string, unknown>)) {
      if (v === null || v === undefined) continue;
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        attributes[k] = String(v);
      }
    }
  }
  const str = (key: string): string | undefined =>
    typeof rec[key] === "string" && (rec[key] as string).length > 0 ? (rec[key] as string) : undefined;
  return {
    id: rec.id,
    code: str("code") ?? "",
    name: str("name") ?? "",
    attributes,
    brand: str("brand"),
    category: str("category"),
    subcategory: str("subcategory"),
  };
}
