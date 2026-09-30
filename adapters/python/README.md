# Python model worker (optional adapter)

The TypeScript search engine is self-contained: BM25F, RRF, caching and the
hashing embedder need **no Python at all**. This worker exists only to serve
model-backed providers locally:

| TS provider | Worker op | What it does |
|---|---|---|
| `reranking.provider: von` | `rerank` | Tiny-LLM relevance judge ("Von") scoring query/product pairs |
| `reranking.provider: cross-encoder` (python mode) | `rerank` | HF cross-encoder pair scoring (BGE / mxbai-rerank / ms-marco) |
| `normalization.provider: tinyllm` | `normalize` | LLM typo correction + attribute extraction (strict JSON) |

## Why a stdio worker and not a microservice?

A child process speaking JSONL over stdin/stdout is the simplest IPC that adds
**zero network surface, zero ports, zero extra deployment**. Round-trip
overhead is ~0.5–2 ms per call (pipe write + line read), amortized by batching
(`reranking.von.batch_size`, default 8). A HTTP/gRPC service would only pay
off with multiple engine processes — see `docs/architecture.md`.

## Protocol

```
→ {"id":"r1","op":"ping"}
← {"id":"r1","ok":true,"result":{"ready":true,"model":"...","rerank_available":true,...}}

→ {"id":"r2","op":"rerank","payload":{
     "query":"tube 110 blanc",
     "documents":[{"id":"P001245","text":"T110B45 | Tube PVC évacuation | ..."}]}}
← {"id":"r2","ok":true,"result":{"scores":[{"id":"P001245","score":0.93}]}}

→ {"id":"r3","op":"normalize","payload":{"query":"tube 110 blnc"}}
← {"id":"r3","ok":true,"result":{"normalized":"tube 110 blanc","attributes":{"color":"blanc"}}}
```

Errors: `{"id":..,"ok":false,"error":{"code":"UNAVAILABLE|INVALID_INPUT|INTERNAL","message":".."}}`.
`UNAVAILABLE` (e.g. `transformers` not installed) makes the TypeScript side
fall back to the configured fallback reranker — the failure is logged loudly,
never hidden.

## Install & run

```bash
pip install -r adapters/python/requirements.txt   # torch CPU + transformers

# Von (LLM judge):
python3 adapters/python/model_worker.py --model Qwen/Qwen2.5-0.5B-Instruct --backend llm

# Cross-encoder reranking (BGE/mxbai style):
python3 adapters/python/model_worker.py --model mixedbread-ai/mxbai-rerank-xsmall-multilingual-v1 --backend crossencoder
```

Normally you never start it by hand: the TypeScript `PythonModelWorker` class
spawns it lazily (`reranking.von.python_path` / `worker_path` in the config).

## Security

- The worker only reads JSON lines from stdin and writes JSON to stdout.
- Model outputs are parsed defensively (regex/JSON) and returned as data.
- Nothing model-generated is ever executed or interpolated into SQL.
