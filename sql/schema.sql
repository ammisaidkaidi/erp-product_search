-- Product search schema (PostgreSQL 14+ with pgvector).
-- __DIM__ is replaced with the configured embedding dimension at init time.
--
-- Design notes:
--  * The ERP's `products` table is NOT duplicated here. `product_search` is a
--    search-only projection produced by SearchDocumentBuilder; it stores the
--    structured fields so in-memory indexes can be rebuilt without the ERP.
--  * `product_embeddings` is a separate table: embeddings can be regenerated
--    (model change) without touching search documents.
--  * `search_events` is the extensible behavior-signal table (clicks,
--    selections, purchases). v1 only writes rows; no ranking model uses them.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS product_search (
    product_id       TEXT PRIMARY KEY,
    search_document  TEXT NOT NULL,
    document_hash    TEXT NOT NULL,
    builder_version  TEXT NOT NULL,
    fields           JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS product_embeddings (
    product_id     TEXT PRIMARY KEY REFERENCES product_search(product_id) ON DELETE CASCADE,
    embedding      vector(__DIM__),
    model_version  TEXT NOT NULL,
    document_hash  TEXT NOT NULL,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS search_configuration (
    key         TEXT PRIMARY KEY,
    value       JSONB NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS search_evaluation_queries (
    id                    BIGSERIAL PRIMARY KEY,
    query                 TEXT NOT NULL,
    relevant_product_ids  JSONB NOT NULL,
    notes                 TEXT,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS search_log (
    search_id            TEXT PRIMARY KEY,
    query                TEXT NOT NULL,
    normalized_query     TEXT,
    result_product_ids   JSONB,
    selected_product_id  TEXT,
    latency_ms           INTEGER,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Extensible behavior signals: click, select, add_to_cart, purchase, ...
CREATE TABLE IF NOT EXISTS search_events (
    id          BIGSERIAL PRIMARY KEY,
    search_id   TEXT,
    event_type  TEXT NOT NULL,
    query       TEXT,
    product_id  TEXT,
    position    INTEGER,
    payload     JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_search_events_search_id ON search_events (search_id);
CREATE INDEX IF NOT EXISTS idx_search_events_type ON search_events (event_type, created_at);

-- ANN index over embeddings (cosine). Requires fixed dimension on the column;
-- created after the table to allow the __DIM__ templating.
CREATE INDEX IF NOT EXISTS idx_product_embeddings_hnsw
    ON product_embeddings USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);
