"""Context de memorii (recall semantic) pentru conversație.
Includes temporal decay scoring and MMR (Maximal Marginal Relevance) diversity."""
import hashlib
import json
import math
import re
import time
from datetime import datetime
import settings as settings_mod
from storage import get_collection, compute_embeddings
from logger import log_line, log_detail

# Cache scurt (TTL 60s) pentru același user_id + query similar, reduce load pe Chroma
_MEMORY_CACHE: dict = {}
_MEMORY_CACHE_TTL = 60.0
_MEMORY_CACHE_MAX_ENTRIES = 200
_LAST_GOOD_MEMORY_BY_USER: dict = {}


def _memory_cache_key(user_id: str, query: str) -> str:
    """Stable cache key (deterministic across process restarts)."""
    q = (query or "")[:300].strip()
    h = hashlib.sha256(q.encode("utf-8")).hexdigest()[:16]
    librarian_cfg = (settings_mod.CFG.get("librarian") or {})
    cfg_blob = json.dumps(librarian_cfg, sort_keys=True, ensure_ascii=False)
    cfg_hash = hashlib.sha256(cfg_blob.encode("utf-8")).hexdigest()[:8]
    return f"{user_id}:{h}:{cfg_hash}"


def _memory_cache_get(key: str) -> str | None:
    now = time.time()
    if key not in _MEMORY_CACHE:
        return None
    val, expiry = _MEMORY_CACHE[key]
    if now > expiry:
        del _MEMORY_CACHE[key]
        return None
    return val


def _memory_cache_set(key: str, value: str) -> None:
    now = time.time()
    while len(_MEMORY_CACHE) >= _MEMORY_CACHE_MAX_ENTRIES:
        oldest = min(_MEMORY_CACHE, key=lambda k: _MEMORY_CACHE[k][1])
        del _MEMORY_CACHE[oldest]
    _MEMORY_CACHE[key] = (value, now + _MEMORY_CACHE_TTL)


def _format_memory_date(ts: float) -> str:
    """Dată/ora lizibilă pentru model (când a fost salvat faptul). Returnează '' dacă ts invalid."""
    if not ts or ts <= 0:
        return ""
    try:
        # Support both Unix seconds (~1e9) and milliseconds (~1e12)
        sec = ts / 1000.0 if ts > 1e12 else ts
        d = datetime.fromtimestamp(sec)
        return d.strftime("%d %b %Y, %H:%M")  # e.g. 15 Feb 2026, 14:30
    except Exception:
        return ""

RE_THINK_BLOCK = re.compile(r"<think>.*?</think>", re.DOTALL)
RE_HTML_TAGS = re.compile(r"<[^>]+>")


def clean_text(text: str) -> str:
    if not text:
        return ""
    text = RE_THINK_BLOCK.sub("", text)
    text = RE_HTML_TAGS.sub("", text)
    text = text.replace("FACT:", "").strip()
    return text


# ── BM25 keyword scoring ────────────────────────────────────────────
_RE_WORD = re.compile(r"\w+", re.UNICODE)


def _tokenize(text: str) -> list[str]:
    return _RE_WORD.findall(text.lower())


def _bm25_score(query_tokens: list[str], doc_tokens: list[str],
                avg_dl: float, k1: float = 1.5, b: float = 0.75) -> float:
    """Simple single-document BM25 score (IDF ignored — we only rank among a small result set)."""
    dl = len(doc_tokens)
    if dl == 0 or avg_dl == 0:
        return 0.0
    freq: dict[str, int] = {}
    for t in doc_tokens:
        freq[t] = freq.get(t, 0) + 1
    score = 0.0
    for qt in query_tokens:
        tf = freq.get(qt, 0)
        if tf > 0:
            numerator = tf * (k1 + 1)
            denominator = tf + k1 * (1 - b + b * dl / avg_dl)
            score += numerator / denominator
    return score


def get_memory_context(user_text: str, prev_context: str, user_id: str) -> str:
    if not user_text or len(user_text) < 2:
        return ""
    # Use just the user's message for search (prev_context adds noise)
    search_query = user_text.strip()[:500]
    cache_key = _memory_cache_key(str(user_id), search_query)
    cached = _memory_cache_get(cache_key)
    if cached is not None:
        return cached
    lib_cfg = settings_mod.CFG.get("librarian", {})
    limit = lib_cfg.get("retrieval_limit", 5)
    max_dist = lib_cfg.get("memory_relevance_max_distance")
    use_relevance_filter = max_dist is not None
    recency_penalty = float(lib_cfg.get("recency_penalty", 0.002))
    now = time.time()

    def _collect_relevant(results) -> list:
        """Returns list of dicts: {text, distance, timestamp, bm25} for hybrid ranking."""
        found = []
        if not results.get("documents") or not results["documents"][0]:
            return found
        docs = results["documents"][0]
        metadatas = results.get("metadatas") or [[]]
        distances = results.get("distances")
        dist_list = distances[0] if (distances and isinstance(distances, list) and len(distances) > 0) else None
        query_tokens = _tokenize(search_query)
        # Collect all doc tokens for avg_dl
        all_doc_tokens = []
        for doc in docs:
            if doc:
                all_doc_tokens.append(_tokenize(clean_text(doc)))
            else:
                all_doc_tokens.append([])
        avg_dl = sum(len(t) for t in all_doc_tokens) / max(len(all_doc_tokens), 1)
        for i, doc in enumerate(docs):
            if not doc:
                continue
            meta = metadatas[0][i] if i < len(metadatas[0]) else []
            if str(meta.get("user_id")) != str(user_id):
                continue
            d = dist_list[i] if dist_list is not None and i < len(dist_list) else 0.0
            if use_relevance_filter and max_dist is not None and d > max_dist:
                continue
            ts = float(meta.get("timestamp") or now)
            bm25 = _bm25_score(query_tokens, all_doc_tokens[i], avg_dl)
            found.append({"text": clean_text(doc), "distance": d, "timestamp": ts, "bm25": bm25})
        return found

    def _score_and_dedup(items: list) -> list:
        """Score with hybrid (vector + BM25), temporal decay, and MMR diversity."""
        seen_texts = set()
        candidates = []
        # Find max BM25 for normalization
        max_bm25 = max((it.get("bm25", 0) for it in items), default=1.0) or 1.0
        bm25_weight = float(lib_cfg.get("bm25_weight", 0.3))
        for it in items:
            t = (it["text"] or "").strip()
            if not t or t in seen_texts:
                continue
            seen_texts.add(t)
            ts = it.get("timestamp") or 0
            age_hours = (now - ts) / 3600.0 if ts else 0
            # Exponential temporal decay: half-life = 720 hours (~30 days)
            half_life = float(lib_cfg.get("decay_half_life_hours", 720))
            decay = math.exp(-0.693 * age_hours / half_life) if half_life > 0 else 1.0
            # Hybrid score: vector distance (lower=better) boosted by BM25 keyword match
            bm25_norm = it.get("bm25", 0) / max_bm25 if max_bm25 > 0 else 0
            # distance range ~0-2, bm25_norm ~0-1.  Subtract bm25 boost from distance.
            hybrid_distance = it["distance"] - (bm25_weight * bm25_norm)
            base_score = hybrid_distance / max(decay, 0.01)
            candidates.append({"text": t, "ts": ts, "score": base_score, "distance": it["distance"]})
        candidates.sort(key=lambda x: x["score"])
        if not candidates:
            return []

        # MMR diversity pass: avoid returning multiple memories about the same topic
        mmr_lambda = float(lib_cfg.get("mmr_lambda", 0.7))
        selected = [candidates[0]]
        remaining = candidates[1:]
        while len(selected) < limit and remaining:
            best_idx = 0
            best_mmr = float("inf")
            for i, cand in enumerate(remaining):
                # Relevance component (lower = better)
                relevance = cand["score"]
                # Redundancy: simple text overlap (Jaccard) with already-selected items
                cand_words = set(cand["text"].lower().split())
                max_sim = 0.0
                for sel in selected:
                    sel_words = set(sel["text"].lower().split())
                    intersection = len(cand_words & sel_words)
                    union = len(cand_words | sel_words)
                    sim = intersection / union if union > 0 else 0.0
                    max_sim = max(max_sim, sim)
                # MMR: balance relevance vs diversity
                mmr_score = mmr_lambda * relevance + (1 - mmr_lambda) * max_sim
                if mmr_score < best_mmr:
                    best_mmr = mmr_score
                    best_idx = i
            selected.append(remaining.pop(best_idx))
        return [(c["text"], c["ts"]) for c in selected]

    def _format_fact_line(text: str, ts: float) -> str:
        date_str = _format_memory_date(ts)
        if date_str:
            return f"{text} — saved {date_str}"
        return text

    try:
        coll = get_collection()
        results = coll.query(
            query_texts=[search_query],
            n_results=limit * 8,
            where={"$and": [{"user_id": user_id}, {"type": "fact"}]},
            include=["documents", "metadatas", "distances"],
        )
        items = _collect_relevant(results)
        # If distance filter is on and we got nothing, use results anyway (drop distance filter for this request)
        if use_relevance_filter and max_dist is not None and not items and results.get("documents") and results["documents"][0]:
            docs = results["documents"][0]
            metadatas = results.get("metadatas") or [[]]
            meta_list = metadatas[0] if metadatas else []
            distances = results.get("distances") or [[]]
            dist_list = distances[0] if distances else []
            for i, doc in enumerate(docs):
                if not doc:
                    continue
                meta_i = meta_list[i] if i < len(meta_list) else {}
                if str(meta_i.get("user_id")) != str(user_id):
                    continue
                d = dist_list[i] if dist_list and i < len(dist_list) else 0.0
                ts = float(meta_i.get("timestamp") or now)
                items.append({"text": clean_text(doc), "distance": d, "timestamp": ts})
        unique_docs = _score_and_dedup(items)
        lines = [_format_fact_line(t, ts) for t, ts in unique_docs]
        if lines:
            log_line("mem", "🧠", "RECALL", f"Found {len(lines)} facts (hybrid+MMR)" + (f" (d<={max_dist})" if use_relevance_filter else ""))
        log_detail("memory", "RECALL", user_id=user_id, query_len=len(search_query), facts_found=len(lines), limit=limit, max_dist=max_dist)
        result = "\n".join(lines)
        _memory_cache_set(cache_key, result)
        _LAST_GOOD_MEMORY_BY_USER[str(user_id)] = result
        return result
    except Exception as e:
        log_detail("memory", "RECALL_ERROR", user_id=user_id, error=str(e))
        try:
            coll = get_collection()
            results = coll.query(
                query_texts=[search_query],
                n_results=limit * 8,
                where={"user_id": user_id},
                include=["documents", "metadatas", "distances"],
            )
            items = _collect_relevant(results)
            unique_docs = _score_and_dedup(items)
            lines = [_format_fact_line(t, ts) for t, ts in unique_docs]
            if lines:
                log_line("mem", "🧠", "RECALL", f"Found {len(lines)} facts (fallback)" + (f" (d<={max_dist}, recency)" if use_relevance_filter else ""))
            log_detail("memory", "RECALL_FALLBACK", user_id=user_id, facts_found=len(lines))
            result = "\n".join(lines)
            _memory_cache_set(cache_key, result)
            _LAST_GOOD_MEMORY_BY_USER[str(user_id)] = result
            return result
        except Exception:
            fallback = _LAST_GOOD_MEMORY_BY_USER.get(str(user_id), "")
            if fallback:
                log_line("mem", "🧠", "RECALL", "Serving stale fallback memory context")
            return fallback
