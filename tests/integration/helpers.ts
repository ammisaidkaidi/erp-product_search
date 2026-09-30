import { Pool } from "pg";
import type { SearchEngineConfig } from "../../src/config/schema.js";
import { DEFAULT_CONFIG, deepMerge } from "../../src/config/schema.js";

/**
 * Integration test database bootstrap. Uses TEST_DATABASE_URL when set,
 * otherwise postgres://postgres@127.0.0.1:5432/product_search_test.
 * The suite is SKIPPED (with a clear message) when no PostgreSQL is reachable —
 * unit tests must always work without a database.
 */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://postgres@127.0.0.1:5432/product_search_test";

export const ADMIN_DATABASE_URL =
  process.env.TEST_ADMIN_DATABASE_URL ?? "postgres://postgres@127.0.0.1:5432/postgres";

export async function ensureTestDatabase(): Promise<boolean> {
  const admin = new Pool({ connectionString: ADMIN_DATABASE_URL, connectionTimeoutMillis: 3000, max: 2 });
  try {
    await admin.query("SELECT 1");
  } catch {
    await admin.end().catch(() => {});
    return false;
  }
  const url = new URL(TEST_DATABASE_URL);
  const dbName = url.pathname.replace(/^\//, "") || "product_search_test";
  const exists = await admin.query<{ exists: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS exists",
    [dbName],
  );
  if (!exists.rows[0]!.exists) {
    await admin.query(`CREATE DATABASE ${JSON.stringify(dbName)}`);
  }
  await admin.end();
  return true;
}

export async function dropAllTables(url: string): Promise<void> {
  const pool = new Pool({ connectionString: url, max: 2 });
  await pool.query(`DROP TABLE IF EXISTS product_embeddings, product_search, search_configuration,
    search_evaluation_queries, search_log, search_events CASCADE`);
  await pool.end();
}

export function integrationConfig(overrides: Partial<SearchEngineConfig["database"]> = {}): SearchEngineConfig {
  return deepMerge(DEFAULT_CONFIG, {
    database: { url: TEST_DATABASE_URL, ...overrides },
    cache: { enabled: false },
  });
}
