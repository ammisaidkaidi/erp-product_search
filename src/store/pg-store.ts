import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { StoreError } from "../core/errors.js";
import type { RetrievalResult } from "../core/types.js";
import type { DatabaseConfig, VectorMetric } from "../config/schema.js";
import type {
  BehaviorEventRow,
  EmbeddingMeta,
  EmbeddingRow,
  SearchDocRow,
  SearchLogRow,
  SearchStore,
} from "./search-store.js";

/**
 * PostgreSQL + pgvector SearchStore (production implementation).
 *
 * - all statements are parameterized; normalized query text never becomes SQL
 * - schema is created idempotently from sql/schema.sql with the configured
 *   embedding dimension
 * - iteration uses keyset pagination (constant memory at 100k+ docs)
 * - vector search uses the <=> (cosine) or <#> (inner product) operators with
 *   an HNSW index; embeddings for deleted products are excluded via a join
 */
export interface PgSearchStoreOptions {
  config: DatabaseConfig;
  embeddingDimensions: number;
  metric: VectorMetric;
  /** Override schema file path (tests). */
  schemaFile?: string;
}

export class PgSearchStore implements SearchStore {
  readonly id = "postgres";
  private pool: Pool | null = null;
  private readonly opts: PgSearchStoreOptions;
  private readonly retrieverId = "vector";

  constructor(opts: PgSearchStoreOptions) {
    this.opts = opts;
  }

  private get client(): Pool {
    if (!this.pool) throw new StoreError("PgSearchStore used before init()");
    return this.pool;
  }

  async init(): Promise<void> {
    if (this.pool) return;
    const c = this.opts.config;
    this.pool = new Pool({
      connectionString: c.url,
      host: c.url ? undefined : c.host,
      port: c.url ? undefined : c.port,
      user: c.url ? undefined : c.user,
      password: c.url ? undefined : c.password,
      database: c.url ? undefined : c.database,
      max: c.poolMax,
      connectionTimeoutMillis: c.connectTimeoutMs,
    });
    this.pool.on("error", (err) => {
      // background client errors must not crash the process
      if (typeof process !== "undefined" && typeof process.emitWarning === "function") {
        process.emitWarning(`pg idle client error: ${err.message}`);
      }
    });

    try {
      await this.applyStatementTimeout();
      await this.migrate();
    } catch (e) {
      await this.pool.end().catch(() => {});
      this.pool = null;
      throw e;
    }
  }

  private async withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.client.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }

  private async applyStatementTimeout(): Promise<void> {
    const timeout = this.opts.config.statementTimeoutMs;
    await this.withClient(async (client) => {
      await client.query(`SET statement_timeout = ${Number.isInteger(timeout) ? timeout : 15000}`);
    });
  }

  private async migrate(): Promise<void> {
    const schemaFile =
      this.opts.schemaFile ?? fileURLToPath(new URL("../../sql/schema.sql", import.meta.url));
    let sql: string;
    try {
      sql = await readFile(schemaFile, "utf8");
    } catch (e) {
      throw new StoreError(`Schema file not found: ${schemaFile}`, e);
    }
    const dim = this.opts.embeddingDimensions;
    const statements = sql
      .replace(/__DIM__/g, String(dim))
      .split(/;\s*\n/)
      .map((s) => s.replace(/--.*$/gm, "").trim())
      .filter((s) => s.length > 0);

    await this.withClient(async (client) => {
      for (const statement of statements) {
        try {
          await client.query(statement);
        } catch (e) {
          const msg = (e as Error).message;
          // "extension vector is not available" => pgvector missing
          if (msg.includes("extension") && msg.includes("vector")) {
            throw new StoreError(
              "pgvector extension is not available on this PostgreSQL server. Install postgresql-<version>-pgvector then retry.",
              e,
            );
          }
          // Existing embeddings table with a different dimension is a hard,
          // actionable error (embedding model changed without rebuild).
          if (msg.includes("dimensions do not match") || msg.includes("expected")) {
            throw new StoreError(
              `product_embeddings.embedding dimension mismatch (configured: ${dim}). ` +
                `Run 'search-index rebuild' with the new dimension or revert embedding.dimensions.`,
              e,
            );
          }
          throw new StoreError(`Schema migration failed: ${msg}`, e);
        }
      }
      // Verify / fix embedding column dimension (covers pre-existing untyped columns).
      const dimResult = await client.query<{ atttypmod: number }>(
        `SELECT atttypmod FROM pg_attribute
         WHERE attrelid = 'product_embeddings'::regclass AND attname = 'embedding' AND NOT attisdropped`,
      );
      const current = dimResult.rows[0]?.atttypmod; // vector dim stored as typmod; -1 => untyped
      if (current === undefined) {
        throw new StoreError("product_embeddings table missing after migration");
      }
      if (current === -1) {
        await client.query(`ALTER TABLE product_embeddings ALTER COLUMN embedding TYPE vector(${dim})`);
      } else if (current !== dim) {
        throw new StoreError(
          `product_embeddings.embedding has dimension ${current} but embedding.dimensions=${dim}. ` +
            `Drop product_embeddings or run a full rebuild with the new model.`,
        );
      }
    });
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  // ---------------------------------------------------------------- docs

  async upsertSearchDocs(rows: SearchDocRow[]): Promise<void> {
    if (rows.length === 0) return;
    await this.withClient(async (client) => {
      for (let i = 0; i < rows.length; i += 500) {
        const batch = rows.slice(i, i + 500);
        const ids = batch.map((r) => r.productId);
        const docs = batch.map((r) => r.searchDocument);
        const hashes = batch.map((r) => r.documentHash);
        const versions = batch.map((r) => r.builderVersion);
        const fields = batch.map((r) => JSON.stringify(serializeProduct(r.product)));
        await client.query(
          `INSERT INTO product_search (product_id, search_document, document_hash, builder_version, fields)
           SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::jsonb[])
           ON CONFLICT (product_id) DO UPDATE SET
             search_document = EXCLUDED.search_document,
             document_hash = EXCLUDED.document_hash,
             builder_version = EXCLUDED.builder_version,
             fields = EXCLUDED.fields,
             updated_at = now()`,
          [ids, docs, hashes, versions, fields],
        );
      }
    });
  }

  async deleteSearchDocs(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.withClient(async (client) => {
      await client.query(`DELETE FROM product_search WHERE product_id = ANY($1::text[])`, [ids]);
    });
  }

  async getSearchDocs(ids: string[]): Promise<SearchDocRow[]> {
    if (ids.length === 0) return [];
    return this.withClient(async (client) => {
      const result = await client.query<QueryResultRow>(
        `SELECT product_id, search_document, document_hash, builder_version, fields, updated_at
         FROM product_search WHERE product_id = ANY($1::text[])`,
        [ids],
      );
      return result.rows.map((row) => rowToSearchDoc(row));
    });
  }

  async *iterateSearchDocs(batchSize = 1000): AsyncIterable<SearchDocRow> {
    let cursor: string | null = null;
    while (true) {
      const rows: SearchDocRow[] = await this.withClient(async (client) => {
        const result = await client.query<QueryResultRow>(
          `SELECT product_id, search_document, document_hash, builder_version, fields, updated_at
           FROM product_search
           WHERE ($1::text IS NULL OR product_id > $1)
           ORDER BY product_id ASC
           LIMIT $2`,
          [cursor, batchSize],
        );
        return result.rows.map((row) => rowToSearchDoc(row));
      });
      if (rows.length === 0) return;
      for (const row of rows) yield row;
      cursor = rows[rows.length - 1]!.productId;
    }
  }

  async countSearchDocs(): Promise<number> {
    const result = await this.client.query<{ count: string }>(`SELECT count(*)::text AS count FROM product_search`);
    return Number(result.rows[0]!.count);
  }

  // ------------------------------------------------------------ embeddings

  async getEmbeddingMeta(ids: string[]): Promise<Map<string, EmbeddingMeta>> {
    if (ids.length === 0) return new Map();
    return this.withClient(async (client) => {
      const result = await client.query<QueryResultRow>(
        `SELECT product_id, model_version, document_hash FROM product_embeddings WHERE product_id = ANY($1::text[])`,
        [ids],
      );
      const out = new Map<string, EmbeddingMeta>();
      for (const row of result.rows) {
        out.set(row.product_id as string, {
          modelVersion: row.model_version as string,
          documentHash: row.document_hash as string,
        });
      }
      return out;
    });
  }

  async upsertEmbeddings(rows: EmbeddingRow[]): Promise<void> {
    if (rows.length === 0) return;
    await this.withClient(async (client) => {
      for (let i = 0; i < rows.length; i += 500) {
        const batch = rows.slice(i, i + 500);
        const ids = batch.map((r) => r.productId);
        const vectors = batch.map((r) => vectorLiteral(r.embedding));
        const models = batch.map((r) => r.modelVersion);
        const hashes = batch.map((r) => r.documentHash);
        await client.query(
          `INSERT INTO product_embeddings (product_id, embedding, model_version, document_hash)
           SELECT * FROM unnest($1::text[], $2::vector[], $3::text[], $4::text[])
           ON CONFLICT (product_id) DO UPDATE SET
             embedding = EXCLUDED.embedding,
             model_version = EXCLUDED.model_version,
             document_hash = EXCLUDED.document_hash,
             updated_at = now()`,
          [ids, vectors, models, hashes],
        );
      }
    });
  }

  async deleteEmbeddings(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.withClient(async (client) => {
      await client.query(`DELETE FROM product_embeddings WHERE product_id = ANY($1::text[])`, [ids]);
    });
  }

  async countEmbeddings(modelVersion: string): Promise<number> {
    const result = await this.client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM product_embeddings WHERE model_version = $1`,
      [modelVersion],
    );
    return Number(result.rows[0]!.count);
  }

  async searchVectors(embedding: number[], modelVersion: string, limit: number): Promise<RetrievalResult[]> {
    const literal = vectorLiteral(embedding);
    if (this.opts.metric === "inner-product") {
      const result = await this.client.query<{ product_id: string; score: string }>(
        `SELECT e.product_id, -(e.embedding <#> $1::vector) AS score
         FROM product_embeddings e
         JOIN product_search s ON s.product_id = e.product_id
         WHERE e.model_version = $2
         ORDER BY e.embedding <#> $1::vector
         LIMIT $3`,
        [literal, modelVersion, limit],
      );
      return result.rows.map((row) => ({
        productId: row.product_id,
        score: Number(row.score),
        retrieverId: this.retrieverId,
      }));
    }
    const result = await this.client.query<{ product_id: string; score: string }>(
      `SELECT e.product_id, 1 - (e.embedding <=> $1::vector) AS score
       FROM product_embeddings e
       JOIN product_search s ON s.product_id = e.product_id
       WHERE e.model_version = $2
       ORDER BY e.embedding <=> $1::vector
       LIMIT $3`,
      [literal, modelVersion, limit],
    );
    return result.rows.map((row) => ({
      productId: row.product_id,
      score: Number(row.score),
      retrieverId: this.retrieverId,
    }));
  }

  // --------------------------------------------------------------- config

  async getConfig(key: string): Promise<unknown | null> {
    const result = await this.client.query<{ value: unknown }>(
      `SELECT value FROM search_configuration WHERE key = $1`,
      [key],
    );
    return result.rows[0]?.value ?? null;
  }

  async setConfig(key: string, value: unknown): Promise<void> {
    await this.client.query(
      `INSERT INTO search_configuration (key, value, updated_at) VALUES ($1, $2::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, JSON.stringify(value)],
    );
  }

  // ----------------------------------------------------------------- logs

  async logSearchEvent(row: SearchLogRow): Promise<void> {
    await this.client.query(
      `INSERT INTO search_log (search_id, query, normalized_query, result_product_ids, latency_ms)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       ON CONFLICT (search_id) DO NOTHING`,
      [row.searchId, row.query, row.normalizedQuery, JSON.stringify(row.resultProductIds), Math.round(row.latencyMs)],
    );
  }

  async logBehaviorEvent(row: BehaviorEventRow): Promise<void> {
    await this.client.query(
      `INSERT INTO search_events (search_id, event_type, query, product_id, position, payload)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [row.searchId ?? null, row.eventType, row.query ?? null, row.productId ?? null, row.position ?? null, JSON.stringify(row.payload ?? {})],
    );
  }

  async saveEvaluationQueries(entries: Array<{ query: string; relevantProductIds: string[]; notes?: string }>): Promise<void> {
    if (entries.length === 0) return;
    await this.withClient(async (client) => {
      for (const entry of entries) {
        await client.query(
          `INSERT INTO search_evaluation_queries (query, relevant_product_ids, notes) VALUES ($1, $2::jsonb, $3)`,
          [entry.query, JSON.stringify(entry.relevantProductIds), entry.notes ?? null],
        );
      }
    });
  }

  async listEvaluationQueries(): Promise<Array<{ query: string; relevantProductIds: string[]; notes?: string }>> {
    const result = await this.client.query<{ query: string; relevant_product_ids: unknown; notes: string | null }>(
      `SELECT query, relevant_product_ids, notes FROM search_evaluation_queries ORDER BY id`,
    );
    return result.rows.map((row) => ({
      query: row.query,
      relevantProductIds: (row.relevant_product_ids as string[]) ?? [],
      ...(row.notes ? { notes: row.notes } : {}),
    }));
  }
}

// ------------------------------------------------------------------- helpers

function serializeProduct(product: SearchDocRow["product"]): Record<string, unknown> {
  return {
    productId: product.productId,
    code: product.code,
    name: product.name,
    attributes: product.attributes,
    brand: product.brand,
    category: product.category,
    subcategory: product.subcategory,
    searchDocument: product.searchDocument,
    builderVersion: product.builderVersion,
    documentHash: product.documentHash,
  };
}

function rowToSearchDoc(row: QueryResultRow): SearchDocRow {
  const fields = row.fields as Record<string, unknown>;
  return {
    productId: row.product_id as string,
    searchDocument: row.search_document as string,
    documentHash: row.document_hash as string,
    builderVersion: row.builder_version as string,
    updatedAt: new Date(row.updated_at as string),
    product: {
      productId: fields.productId as string,
      code: (fields.code as string) ?? "",
      name: (fields.name as string) ?? "",
      attributes: (fields.attributes as Record<string, string>) ?? {},
      brand: fields.brand as string | undefined,
      category: fields.category as string | undefined,
      subcategory: fields.subcategory as string | undefined,
      searchDocument: row.search_document as string,
      builderVersion: row.builder_version as string,
      documentHash: row.document_hash as string,
    },
  };
}

/** Safe pgvector literal: only finite numbers pass; input text never reaches SQL unparameterized. */
function vectorLiteral(embedding: number[]): string {
  const parts = embedding.map((v) => {
    if (!Number.isFinite(v)) throw new StoreError(`Embedding contains non-finite value: ${v}`);
    return String(v);
  });
  return `[${parts.join(",")}]`;
}
