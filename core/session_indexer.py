"""Session Transcript Indexing — index completed session exchanges into ChromaDB
so past conversations are searchable via memory recall.

Each indexed chunk is a user+assistant exchange pair, stored with type='session_transcript'
and the session_id in metadata. Only indexes new exchanges since the last indexing."""

import hashlib
import time
import logging

from storage import get_collection

_log = logging.getLogger("session_indexer")

# Minimum exchange length worth indexing (skip trivial greetings)
_MIN_EXCHANGE_LEN = 40


def _exchange_id(session_id: str, idx: int) -> str:
    """Deterministic ID for a session exchange so we don't double-index."""
    raw = f"sess:{session_id}:ex:{idx}"
    return hashlib.sha256(raw.encode()).hexdigest()[:24]


def index_session_exchanges(session: dict, user_id: str) -> int:
    """Index user+assistant exchange pairs from a session into ChromaDB.
    Returns the number of newly indexed exchanges."""
    if not session or not user_id:
        return 0
    session_id = session.get("id", "")
    messages = session.get("messages") or []
    if len(messages) < 2:
        return 0

    # Track what we've already indexed via session metadata
    indexed_up_to = session.get("_indexed_up_to", 0)

    coll = get_collection()
    ids_to_add = []
    docs_to_add = []
    metas_to_add = []
    now = time.time()

    i = indexed_up_to
    while i < len(messages) - 1:
        msg_u = messages[i]
        msg_a = messages[i + 1]
        if msg_u.get("role") == "user" and msg_a.get("role") == "assistant":
            user_text = (msg_u.get("content") or "").strip()
            asst_text = (msg_a.get("content") or "").strip()
            if isinstance(user_text, list):
                # multimodal content
                user_text = " ".join(
                    p.get("text", "") for p in user_text if isinstance(p, dict) and p.get("type") == "text"
                )
            # Strip thinking blocks from assistant text
            import re
            asst_text = re.sub(r"<think>.*?</think>", "", asst_text, flags=re.DOTALL).strip()
            exchange = f"Q: {user_text}\nA: {asst_text}"
            if len(exchange) >= _MIN_EXCHANGE_LEN:
                eid = _exchange_id(session_id, i)
                ids_to_add.append(eid)
                # Truncate very long exchanges to keep embedding quality
                docs_to_add.append(exchange[:2000])
                metas_to_add.append({
                    "type": "session_transcript",
                    "user_id": user_id,
                    "session_id": session_id,
                    "exchange_idx": i,
                    "timestamp": msg_a.get("timestamp") or now,
                })
            i += 2
        else:
            i += 1

    if not ids_to_add:
        return 0

    try:
        # Use upsert to avoid duplicates
        coll.upsert(ids=ids_to_add, documents=docs_to_add, metadatas=metas_to_add)
        _log.info(f"Indexed {len(ids_to_add)} exchanges from session {session_id[:8]}")
        return len(ids_to_add)
    except Exception as e:
        _log.warning(f"Session indexing failed: {e}")
        return 0
