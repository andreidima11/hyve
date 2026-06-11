"""Hipocamp: consolidare memorii (deduplicare + AI prune), rulare la oră configurată."""
import json
import re
import time
import os
import uuid
from typing import List, Tuple, Dict, Any
from datetime import datetime, timezone

import numpy as np

import core.storage as storage
from core.storage import collection, compute_embeddings
from core.logger import log_line

from brain.synapses import (
    append_event,
    EVENT_CONSOLIDATION_START,
    EVENT_CONSOLIDATION_END,
    EVENT_CONSOLIDATION_DEDUPE,
    EVENT_CONSOLIDATION_AI_PRUNE,
)


def _cosine_distance(emb1, emb2) -> float:
    """Scalar cosine distance kept for backward compatibility / single calls.
    The consolidation hot path uses :func:`_pairwise_cosine_distance` instead."""
    if emb1 is None or emb2 is None:
        return 2.0
    a = np.asarray(emb1, dtype=np.float32)
    b = np.asarray(emb2, dtype=np.float32)
    if a.size == 0 or a.shape != b.shape:
        return 2.0
    na = float(np.linalg.norm(a))
    nb = float(np.linalg.norm(b))
    if na == 0.0 or nb == 0.0:
        return 2.0
    return float(1.0 - (a @ b) / (na * nb))


def _pairwise_cosine_distance(embeddings) -> np.ndarray:
    """Vectorised pairwise cosine distance. Returns an (N, N) float32 matrix.
    Replaces the previous O(N²) Python inner loop with a single matmul on
    L2-normalised vectors (10-50x faster for N>=100)."""
    mat = np.asarray(embeddings, dtype=np.float32)
    if mat.ndim != 2 or mat.shape[0] == 0:
        return np.empty((0, 0), dtype=np.float32)
    norms = np.linalg.norm(mat, axis=1, keepdims=True)
    norms[norms == 0.0] = 1.0
    normed = mat / norms
    sim = normed @ normed.T
    np.clip(sim, -1.0, 1.0, out=sim)
    return 1.0 - sim


def run_consolidation(threshold: float = 0.92) -> dict:
    """
    Găsește perechi de fapte foarte similare (per user), șterge duplicatul (păstrează cel mai vechi).
    Returnează {"merged": n, "deleted_ids": [...], "errors": [...]}.
    """
    result = {"merged": 0, "deleted_ids": [], "errors": []}
    try:
        append_event(EVENT_CONSOLIDATION_START, summary="Consolidation started", details={"threshold": threshold})
        log_line("mem", "🔄", "CONSOLIDATION", "Start")

        data = collection.get(limit=2000, where={"type": "fact"}, include=["documents", "metadatas"])
        if not data["ids"]:
            append_event(EVENT_CONSOLIDATION_END, summary="No facts to consolidate", details=result)
            return result

        ids = data["ids"]
        docs = data["documents"]
        metas = data["metadatas"]
        by_user: dict = {}
        for i, mid in enumerate(ids):
            uid = (metas[i] or {}).get("user_id") or "anon"
            if uid not in by_user:
                by_user[uid] = []
            by_user[uid].append((mid, docs[i] if docs else "", (metas[i] or {}).get("timestamp", 0)))

        emb_fn = compute_embeddings
        if emb_fn is None:
            result["errors"].append("No embedding function")
            log_line("error", "⚠️", "CONSOLIDATION", "Skipped: no embedding function")
            append_event(EVENT_CONSOLIDATION_END, summary="Skipped (no embeddings)", details=result)
            return result

        for user_id, items in by_user.items():
            if len(items) < 2:
                continue
            texts = [t for _, t, _ in items]
            embeddings = emb_fn(texts)
            if not embeddings or len(embeddings) != len(items):
                log_line("mem", "🔄", "CONSOLIDATION", f"Skipped user {user_id}: no embeddings or length mismatch")
                continue
            # Vectorised pairwise distance: O(N²) memory but a single C-level matmul.
            dist_matrix = _pairwise_cosine_distance(embeddings)
            max_dist = 1.0 - threshold
            n = len(items)
            to_delete: set = set()
            # Iterate upper triangle only; skip already-deleted to mirror old semantics.
            for i in range(n):
                if items[i][0] in to_delete:
                    continue
                row = dist_matrix[i]
                for j in range(i + 1, n):
                    if items[j][0] in to_delete:
                        continue
                    dist = float(row[j])
                    if dist <= max_dist:
                        keep_idx, del_idx = (i, j) if items[i][2] <= items[j][2] else (j, i)
                        to_delete.add(items[del_idx][0])
                        result["merged"] += 1
                        result["deleted_ids"].append(items[del_idx][0])
                        append_event(
                            EVENT_CONSOLIDATION_DEDUPE,
                            user_id=user_id,
                            summary=f"Merged similar: kept {items[keep_idx][0][:20]}..., removed {items[del_idx][0][:20]}...",
                            details={"kept_id": items[keep_idx][0], "deleted_id": items[del_idx][0], "distance": round(dist, 4)},
                        )
                        log_line("mem", "🔄", "CONSOLIDATION", f"Dedupe: deleted {items[del_idx][0]} (user={user_id})")

            for mid in to_delete:
                try:
                    collection.delete(ids=[mid])
                except Exception as e:
                    result["errors"].append(str(e))
                    log_line("error", "⚠️", "CONSOLIDATION", f"Delete failed: {mid} — {e}")

        append_event(EVENT_CONSOLIDATION_END, summary=f"Merged {result['merged']} duplicate(s)", details=result)
        log_line("mem", "🔄", "CONSOLIDATION", f"Done: merged={result['merged']}, deleted={len(result['deleted_ids'])}")
    except Exception as e:
        result["errors"].append(str(e))
        log_line("error", "⚠️", "CONSOLIDATION", str(e))
        append_event(EVENT_CONSOLIDATION_END, summary=f"Error: {e}", details=result)
    return result


def run_ai_prune(consolidation_cfg: Dict[str, Any], llm_url: str, llm_model: str) -> dict:
    """
    După dedupe: trimite fapte per user la LLM; acesta returnează ce id-uri să ștergem (junk/obsolete).
    Returnează {"pruned": n, "deleted_ids": [...], "errors": []}.
    """
    result = {"pruned": 0, "deleted_ids": [], "errors": []}
    if not consolidation_cfg.get("ai_prune") or not llm_url or not llm_model:
        return result
    max_per_user = int(consolidation_cfg.get("ai_prune_max_facts_per_user", 50))
    try:
        data = collection.get(limit=2000, where={"type": "fact"}, include=["documents", "metadatas"])
        if not data["ids"]:
            return result
        ids = data["ids"]
        docs = data["documents"]
        metas = data["metadatas"]
        by_user: Dict[str, List[Tuple[str, str, float]]] = {}
        for i, mid in enumerate(ids):
            uid = (metas[i] or {}).get("user_id") or "anon"
            if uid not in by_user:
                by_user[uid] = []
            ts = (metas[i] or {}).get("timestamp", 0)
            by_user[uid].append((mid, docs[i] if docs else "", ts))

        import httpx
        prompt_tpl = """These are stored facts about a user (id: text). Return a JSON object with one key: "delete_ids" — a list of fact IDs to DELETE because they are junk, too vague, duplicate, or obsolete. Keep clear preferences and important events. If nothing to delete, return {"delete_ids": []}. Output ONLY valid JSON, no other text.

Facts:
%s

JSON:"""

        # Reuse a single connection for every user → avoids the ~50ms TCP/TLS
        # handshake per user that we paid before.
        with httpx.Client(timeout=45) as client:
            for user_id, items in by_user.items():
                items_sorted = sorted(items, key=lambda x: -x[2])[:max_per_user]
                if not items_sorted:
                    continue
                valid_ids = {x[0] for x in items_sorted}
                lines = "\n".join(f"{mid}: {doc[:200]}" for mid, doc, _ in items_sorted)
                prompt = prompt_tpl % lines
                try:
                    r = client.post(
                        llm_url,
                        json={
                            "model": llm_model,
                            "messages": [{"role": "user", "content": prompt}],
                            "temperature": 0,
                            "max_tokens": 500,
                        },
                    )
                except Exception as e:
                    result["errors"].append(f"LLM {user_id}: {e}")
                    log_line("error", "⚠️", "CONSOLIDATION_AI", str(e))
                    continue
                if r.status_code != 200:
                    result["errors"].append(f"LLM {user_id}: HTTP {r.status_code}")
                    continue
                try:
                    data_resp = r.json()
                    content = (data_resp.get("choices") or [{}])[0].get("message", {}).get("content") or ""
                except Exception:
                    continue
                content = content.strip()
                if content.startswith("```"):
                    content = re.sub(r"^```\w*\n?", "", content).strip()
                    content = re.sub(r"\n?```\s*$", "", content)
                m = re.search(r"\{\s*\"delete_ids\"\s*:\s*\[[^\]]*\]\s*\}", content)
                if not m:
                    continue
                try:
                    parsed = json.loads(m.group(0))
                    delete_ids = list(parsed.get("delete_ids") or [])
                except json.JSONDecodeError:
                    continue
                to_delete = [did for did in delete_ids if did in valid_ids]
                for mid in to_delete:
                    try:
                        collection.delete(ids=[mid])
                        result["deleted_ids"].append(mid)
                        result["pruned"] += 1
                    except Exception as e:
                        result["errors"].append(str(e))
                if to_delete:
                    append_event(
                        EVENT_CONSOLIDATION_AI_PRUNE,
                        user_id=user_id,
                        summary=f"AI prune: deleted {len(to_delete)} fact(s)",
                        details={"deleted_ids": to_delete},
                    )
                    log_line("mem", "🧹", "CONSOLIDATION_AI", f"Pruned {len(to_delete)} (user={user_id})")
    except Exception as e:
        result["errors"].append(str(e))
        log_line("error", "⚠️", "CONSOLIDATION_AI", str(e))
    return result


def _normalize_for_dedupe(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").strip().lower())


def _extract_important_updates(messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Extract high-impact memory candidates from conversation (MVP rule-based)."""
    preference_kw = (
        "prefer", "preferă", "imi place", "îmi place", "i like", "i love", "likes", "loves",
        "favorite", "favourite", "prefers", "nu-mi place", "nu imi place",
    )
    decision_kw = (
        "am stabilit", "stabilim", "decidem", "decis", "we decided", "decision", "we will use",
        "vom folosi", "o sa folosim", "use python", "alegem",
    )
    recurrent_kw = (
        "lucrez la", "lucrăm la", "working on", "project", "interfață ai", "assistant", "backend",
        "ema", "andrei", "workflow",
    )

    candidates: List[Dict[str, Any]] = []
    for msg in messages:
        if (msg.get("role") or "").lower() != "user":
            continue
        raw = str(msg.get("content") or "").strip()
        if not raw:
            continue
        sentences = [s.strip(" -•\t") for s in re.split(r"[\n\.!\?]+", raw) if s.strip()]
        for sentence in sentences:
            s = sentence.strip()
            if len(s) < 8:
                continue
            low = s.lower()
            category = None
            score = 0
            if any(k in low for k in preference_kw):
                category = "FACT"
                score += 4
            if any(k in low for k in decision_kw):
                category = "DECISION"
                score += 5
            if any(k in low for k in recurrent_kw):
                category = "CONTEXT"
                score += 3
            if category is None:
                continue
            if len(s.split()) > 25:
                s = " ".join(s.split()[:25]).strip()
            candidates.append({"text": s, "category": category, "score": score})

    # Dedup in-batch (keep highest score variant)
    by_key: Dict[str, Dict[str, Any]] = {}
    for item in candidates:
        key = _normalize_for_dedupe(item["text"])
        if not key:
            continue
        prev = by_key.get(key)
        if prev is None or int(item.get("score", 0)) > int(prev.get("score", 0)):
            by_key[key] = item
    out = sorted(by_key.values(), key=lambda x: int(x.get("score", 0)), reverse=True)
    return out


def _exists_in_long_term_memory(user_id: str, text: str, max_distance: float = 0.28) -> bool:
    """Semantic dedup check against vector DB."""
    try:
        res = collection.query(
            query_texts=[text],
            n_results=3,
            where={"$and": [{"user_id": user_id}, {"type": "fact"}]},
            include=["distances"],
        )
        distances = (res.get("distances") or [[]])[0] if res else []
        return any((d is not None and float(d) <= float(max_distance)) for d in distances)
    except Exception:
        return False


def _append_daily_history_markdown(date_key: str, user_id: str, points: List[Dict[str, Any]], path: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True) if os.path.dirname(path) else None
    lines = [f"\n{date_key}: [Consolidated memory updates for {user_id}]\n"]
    for p in points:
        category = p.get("category", "FACT")
        text = p.get("text", "").strip()
        if text:
            lines.append(f"- [{category}] {text}\n")
    with open(path, "a", encoding="utf-8") as f:
        f.writelines(lines)


def _save_profile_updates_to_vector_db(user_id: str, points: List[Dict[str, Any]], date_key: str) -> int:
    saved = 0
    ts = time.time()
    for idx, p in enumerate(points):
        text = (p.get("text") or "").strip()
        if not text:
            continue
        fid = f"consolidated_{user_id}_{date_key}_{idx}_{uuid.uuid4().hex[:8]}"
        meta = {
            "timestamp": ts,
            "user_id": user_id,
            "type": "fact",
            "source": "memory_consolidation_mvp",
            "category": (p.get("category") or "FACT"),
            "day": date_key,
        }
        try:
            collection.add(documents=[text], metadatas=[meta], ids=[fid])
            saved += 1
        except Exception:
            continue
    return saved


def consolidate_session_memory_mvp(session_id: str, trigger_reason: str = "threshold") -> Dict[str, Any]:
    """MVP memory consolidation for one session.

    Triggered by message threshold or daily rollover.
    Keeps only top ~20% high-impact updates and deduplicates against long-term memory.
    """
    result = {
        "session_id": session_id,
        "trigger": trigger_reason,
        "analyzed_messages": 0,
        "candidates": 0,
        "kept": 0,
        "saved": 0,
        "dedup_skipped": 0,
        "history_log": "",
    }
    session = storage.get_session(session_id)
    if not session:
        return result

    user_id = str(session.get("user_id") or "anon")
    messages = list(session.get("messages") or [])
    result["analyzed_messages"] = len(messages)
    if not messages:
        return result

    cfg_intel = (storage.CFG.get("intelligence") or {}).get("consolidation") or {}
    cfg_mem = storage.CFG.get("memory") or {}
    threshold_msgs = int(cfg_intel.get("session_trigger_messages", 50) or 50)
    compression_ratio = float(cfg_intel.get("compression_ratio", 0.2) or 0.2)
    compression_ratio = max(0.05, min(0.5, compression_ratio))
    dedup_threshold = float(cfg_mem.get("fact_similarity_threshold", 0.45) or 0.45)
    dedup_threshold = min(dedup_threshold, 0.35)
    history_log_path = str(cfg_intel.get("history_log_path") or "history_log.md").strip()

    state = session.get("memory_consolidation") or {}
    last_count = int(state.get("last_message_count", 0) or 0)
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    last_day = str(state.get("last_day") or "")

    reached_threshold = (len(messages) - last_count) >= threshold_msgs
    day_changed = bool(last_day and last_day != today)
    forced_daily = trigger_reason == "daily"
    if not (reached_threshold or day_changed or forced_daily):
        return result

    window = messages[last_count:] if last_count > 0 else messages
    candidates = _extract_important_updates(window)
    result["candidates"] = len(candidates)
    if not candidates:
        session["memory_consolidation"] = {
            "last_message_count": len(messages),
            "last_day": today,
            "last_trigger": trigger_reason,
            "last_consolidated_at": time.time(),
        }
        storage.save_session(session_id, session)
        return result

    keep_n = max(1, int(len(candidates) * compression_ratio))
    top_candidates = candidates[:keep_n]
    result["kept"] = len(top_candidates)

    deduped_points: List[Dict[str, Any]] = []
    for point in top_candidates:
        text = point.get("text") or ""
        if _exists_in_long_term_memory(user_id, text, max_distance=dedup_threshold):
            result["dedup_skipped"] += 1
            continue
        deduped_points.append(point)

    if deduped_points:
        result["saved"] = _save_profile_updates_to_vector_db(user_id, deduped_points, today)
        _append_daily_history_markdown(today, user_id, deduped_points, history_log_path)
        result["history_log"] = history_log_path

    session["memory_consolidation"] = {
        "last_message_count": len(messages),
        "last_day": today,
        "last_trigger": trigger_reason,
        "last_consolidated_at": time.time(),
        "last_kept": result["kept"],
        "last_saved": result["saved"],
    }
    storage.save_session(session_id, session)
    log_line(
        "mem",
        "🧩",
        "MEMORY_MVP",
        f"{trigger_reason}: analyzed={result['analyzed_messages']} cand={result['candidates']} kept={result['kept']} saved={result['saved']} dedup={result['dedup_skipped']}",
    )
    return result


def consolidate_all_sessions_daily_mvp(max_sessions: int = 300) -> Dict[str, Any]:
    """Daily batch consolidation across sessions (used by scheduler)."""
    out = {"processed": 0, "consolidated": 0, "errors": 0}
    try:
        sessions = storage.list_all_sessions(limit=max_sessions, offset=0)
    except Exception:
        return out

    for s in sessions:
        sid = s.get("id")
        if not sid:
            continue
        out["processed"] += 1
        try:
            r = consolidate_session_memory_mvp(sid, trigger_reason="daily")
            if int(r.get("saved", 0) or 0) > 0:
                out["consolidated"] += 1
        except Exception:
            out["errors"] += 1
    return out
