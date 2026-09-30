#!/usr/bin/env python3
"""
Local model worker for the ERP product-search library.

Speaks a strict JSONL protocol over stdio so the TypeScript engine can use
local models without any network service:

  request  (stdin):  {"id": "r1", "op": "ping"}
                     {"id": "r2", "op": "rerank",  "payload": {...}}
                     {"id": "r3", "op": "normalize", "payload": {...}}
  response (stdout): {"id": "r1", "ok": true, "result": {...}}
                     {"id": "r2", "ok": false, "error": {"code": "...", "message": "..."}}

Error codes:
  UNAVAILABLE     - model dependencies not installed (actionable message)
  INVALID_INPUT   - malformed payload
  INTERNAL        - model inference failure

Security: model outputs are parsed defensively and echoed back as data only;
nothing here executes model-generated content. The process reads only from
stdin and writes only to stdout/stderr.

Usage:
  python3 model_worker.py --model Qwen/Qwen2.5-0.5B-Instruct --backend llm
  python3 model_worker.py --model mixedbread-ai/mxbai-rerank-xsmall-multilingual-v1 --backend crossencoder
"""

from __future__ import annotations

import argparse
import json
import sys
import traceback
from typing import Any, Dict, List, Optional

# ---------------------------------------------------------------------------
# model backends (lazy, optional dependencies)
# ---------------------------------------------------------------------------


class RerankBackend:
    """Scores (query, document) pairs; higher = more relevant, in [0, 1]."""

    def rerank(self, query: str, documents: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        raise NotImplementedError


class LlmRerankBackend(RerankBackend):
    """Tiny-LLM relevance judge: prompt the model for a 0..1 relevance score."""

    PROMPT_TEMPLATE = (
        "Tu es un moteur de recherche produits pour un ERP de matériaux. "
        "Note la pertinence du produit suivant pour la requête du client.\n"
        "Requête: {query}\n"
        "Produit: {document}\n"
        "Réponds uniquement par un nombre entre 0.0 (pas pertinent) et 1.0 (correspondance exacte)."
    )

    def __init__(self, model_id: str, max_text_length: int = 512):
        try:
            from transformers import AutoModelForCausalLM, AutoTokenizer  # type: ignore
        except ImportError as exc:  # pragma: no cover
            raise RuntimeError(
                "transformers/torch not installed. Run: pip install -r adapters/python/requirements.txt"
            ) from exc
        self.tokenizer = AutoTokenizer.from_pretrained(model_id)
        self.model = AutoModelForCausalLM.from_pretrained(model_id)
        self.model.eval()
        self.max_text_length = max_text_length

    def rerank(self, query: str, documents: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        import torch  # type: ignore

        results: List[Dict[str, Any]] = []
        for doc in documents:
            text = str(doc.get("text", ""))[: self.max_text_length]
            prompt = self.PROMPT_TEMPLATE.format(query=query, document=text)
            inputs = self.tokenizer(prompt, return_tensors="pt")
            with torch.no_grad():
                output = self.model.generate(
                    **inputs,
                    max_new_tokens=8,
                    do_sample=False,
                    pad_token_id=self.tokenizer.eos_token_id,
                )
            answer = self.tokenizer.decode(output[0][inputs["input_ids"].shape[1]:], skip_special_tokens=True)
            results.append({"id": doc.get("id"), "score": parse_first_float(answer, default=0.0)})
        return results


class CrossEncoderRerankBackend(RerankBackend):
    """HF cross-encoder (sequence classification) pair scoring."""

    def __init__(self, model_id: str, max_text_length: int = 512):
        try:
            from transformers import AutoModelForSequenceClassification, AutoTokenizer  # type: ignore
        except ImportError as exc:  # pragma: no cover
            raise RuntimeError(
                "transformers/torch not installed. Run: pip install -r adapters/python/requirements.txt"
            ) from exc
        self.tokenizer = AutoTokenizer.from_pretrained(model_id)
        self.model = AutoModelForSequenceClassification.from_pretrained(model_id)
        self.model.eval()
        self.max_text_length = max_text_length

    def rerank(self, query: str, documents: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        import torch  # type: ignore

        pairs = [
            (query, str(doc.get("text", ""))[: self.max_text_length]) for doc in documents
        ]
        scores: List[float] = []
        batch = 8
        for i in range(0, len(pairs), batch):
            chunk = pairs[i : i + batch]
            encoded = self.tokenizer(
                [q for q, _ in chunk],
                [d for _, d in chunk],
                return_tensors="pt",
                padding=True,
                truncation=True,
                max_length=512,
            )
            with torch.no_grad():
                logits = self.model(**encoded).logits
            # binary relevance models: single logit or 2-class softmax
            if logits.shape[-1] == 1:
                probs = torch.sigmoid(logits.squeeze(-1))
            else:
                probs = torch.softmax(logits, dim=-1)[:, -1]
            scores.extend(float(p) for p in probs)
        return [{"id": doc.get("id"), "score": scores[i]} for i, doc in enumerate(documents)]


class LlmNormalizeBackend:
    """Tiny-LLM query cleanup: typo fixing + attribute extraction, strict JSON out."""

    PROMPT_TEMPLATE = (
        "Corrige la requête de recherche produits suivante (fautes de frappe, abréviations) "
        "et extrais les attributs techniques reconnaissables. "
        "Réponds STRICTEMENT en JSON: {\"normalized\": \"...\", \"attributes\": {\"nom\": \"valeur\"}}. "
        "N'invente aucun attribut qui n'est pas clairement présent. Requête: {query}"
    )

    def __init__(self, model_id: str, max_input_chars: int = 256):
        try:
            from transformers import AutoModelForCausalLM, AutoTokenizer  # type: ignore
        except ImportError as exc:  # pragma: no cover
            raise RuntimeError(
                "transformers/torch not installed. Run: pip install -r adapters/python/requirements.txt"
            ) from exc
        self.tokenizer = AutoTokenizer.from_pretrained(model_id)
        self.model = AutoModelForCausalLM.from_pretrained(model_id)
        self.model.eval()
        self.max_input_chars = max_input_chars

    def normalize(self, query: str) -> Dict[str, Any]:
        import torch  # type: ignore

        prompt = self.PROMPT_TEMPLATE.format(query=query[: self.max_input_chars])
        inputs = self.tokenizer(prompt, return_tensors="pt")
        with torch.no_grad():
            output = self.model.generate(
                **inputs,
                max_new_tokens=128,
                do_sample=False,
                pad_token_id=self.tokenizer.eos_token_id,
            )
        answer = self.tokenizer.decode(output[0][inputs["input_ids"].shape[1]:], skip_special_tokens=True)
        parsed = parse_json_object(answer)
        if parsed is None:
            raise RuntimeError(f"model returned invalid JSON: {answer[:120]!r}")
        normalized = parsed.get("normalized")
        if not isinstance(normalized, str):
            raise RuntimeError("model JSON missing 'normalized' string")
        attributes = parsed.get("attributes", {})
        if not isinstance(attributes, dict):
            attributes = {}
        return {
            "normalized": normalized,
            "attributes": {
                str(k): str(v) for k, v in attributes.items() if isinstance(v, (str, int, float))
            },
        }


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def parse_first_float(text: str, default: float = 0.0) -> float:
    import re

    match = re.search(r"-?\d+(?:[.,]\d+)?", text.replace(",", "."))
    if not match:
        return default
    try:
        value = float(match.group(0))
    except ValueError:
        return default
    return max(0.0, min(1.0, value))


def parse_json_object(text: str) -> Optional[Dict[str, Any]]:
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return None
    try:
        parsed = json.loads(text[start : end + 1])
        return parsed if isinstance(parsed, dict) else None
    except json.JSONDecodeError:
        return None


class WorkerError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


# ---------------------------------------------------------------------------
# protocol
# ---------------------------------------------------------------------------


class Worker:
    def __init__(self, args: argparse.Namespace):
        self.args = args
        self.reranker: Optional[RerankBackend] = None
        self.normalizer: Optional[LlmNormalizeBackend] = None
        self.rerank_error: Optional[str] = None
        self.normalize_error: Optional[str] = None
        self._load()

    def _load(self) -> None:
        # Reranking backend
        try:
            if self.args.backend == "crossencoder":
                self.reranker = CrossEncoderRerankBackend(self.args.model)
            else:
                self.reranker = LlmRerankBackend(self.args.model)
        except Exception as exc:  # noqa: BLE001 - report and stay alive
            self.rerank_error = str(exc)
            print(f"[worker] rerank backend unavailable: {exc}", file=sys.stderr, flush=True)
        # Normalizer backend (tiny-LLM only)
        try:
            self.normalizer = LlmNormalizeBackend(self.args.model)
        except Exception as exc:  # noqa: BLE001
            self.normalize_error = str(exc)
            print(f"[worker] normalize backend unavailable: {exc}", file=sys.stderr, flush=True)

    # -- ops ----------------------------------------------------------------

    def op_ping(self, _payload: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "ready": True,
            "model": self.args.model,
            "backend": self.args.backend,
            "rerank_available": self.reranker is not None,
            "normalize_available": self.normalizer is not None,
            "rerank_error": self.rerank_error,
            "normalize_error": self.normalize_error,
        }

    def op_rerank(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        if self.reranker is None:
            raise WorkerError("UNAVAILABLE", self.rerank_error or "rerank backend not loaded")
        query = payload.get("query")
        documents = payload.get("documents")
        if not isinstance(query, str) or not isinstance(documents, list):
            raise WorkerError("INVALID_INPUT", "payload requires string 'query' and array 'documents'")
        clean_docs = [
            {"id": str(d.get("id")), "text": str(d.get("text", ""))}
            for d in documents
            if isinstance(d, dict)
        ]
        results = self.reranker.rerank(query, clean_docs)
        return {"scores": results}

    def op_normalize(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        if self.normalizer is None:
            raise WorkerError("UNAVAILABLE", self.normalize_error or "normalize backend not loaded")
        query = payload.get("query")
        if not isinstance(query, str):
            raise WorkerError("INVALID_INPUT", "payload requires string 'query'")
        return self.normalizer.normalize(query)

    def handle(self, request: Dict[str, Any]) -> Dict[str, Any]:
        request_id = request.get("id")
        op = request.get("op")
        payload = request.get("payload", {})
        if not isinstance(payload, dict):
            payload = {}
        try:
            if op == "ping":
                result = self.op_ping(payload)
            elif op == "rerank":
                result = self.op_rerank(payload)
            elif op == "normalize":
                result = self.op_normalize(payload)
            else:
                raise WorkerError("INVALID_INPUT", f"unknown op: {op!r}")
        except WorkerError as exc:
            return {"id": request_id, "ok": False, "error": {"code": exc.code, "message": exc.message}}
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc(file=sys.stderr)
            return {"id": request_id, "ok": False, "error": {"code": "INTERNAL", "message": str(exc)}}
        return {"id": request_id, "ok": True, "result": result}

    def run(self) -> None:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                request = json.loads(line)
            except json.JSONDecodeError:
                response: Dict[str, Any] = {
                    "id": None,
                    "ok": False,
                    "error": {"code": "INVALID_INPUT", "message": "invalid JSON line"},
                }
            else:
                if not isinstance(request, dict):
                    response = {
                        "id": None,
                        "ok": False,
                        "error": {"code": "INVALID_INPUT", "message": "request must be a JSON object"},
                    }
                else:
                    response = self.handle(request)
            sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
            sys.stdout.flush()


def main() -> None:
    parser = argparse.ArgumentParser(description="product-search local model worker")
    parser.add_argument("--model", default="Qwen/Qwen2.5-0.5B-Instruct", help="HF model id")
    parser.add_argument("--backend", default="llm", choices=["llm", "crossencoder"])
    parser.add_argument("--self-test", action="store_true", help="load models then exit (init smoke test)")
    args = parser.parse_args()
    worker = Worker(args)
    if args.self_test:
        print(json.dumps(worker.op_ping({}), ensure_ascii=False))
        return
    worker.run()


if __name__ == "__main__":
    main()
