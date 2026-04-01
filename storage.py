import os
import re
import json
import time
import uuid
import glob
import logging
import hashlib
import gc

# Reduce Hugging Face / transformers noise before any model load
os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

import chromadb
from chromadb.config import Settings
from chromadb.utils import embedding_functions
from settings import CFG

# --- CHROMA DB SETUP ---
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"

# Disable ChromaDB telemetry to avoid PostHog atexit errors on Ctrl+C
client_db = chromadb.PersistentClient(
    path="./chroma_db",
    settings=Settings(anonymized_telemetry=False),
)

_emb_fn = None  # cache global


def shutdown_storage():
    """Release Chroma and embedding-model resources for clean process shutdown."""
    global _emb_fn
    log = logging.getLogger("storage")

    model = getattr(_emb_fn, "_model", None) if _emb_fn is not None else None
    if model is not None:
        try:
            stop_multi_process_pool = getattr(model, "stop_multi_process_pool", None)
            pool = getattr(model, "pool", None)
            if callable(stop_multi_process_pool) and pool is not None:
                stop_multi_process_pool(pool)
        except Exception as e:
            log.debug("stop_multi_process_pool failed during shutdown: %s", e)
        try:
            model.cpu()
        except Exception as e:
            log.debug("model.cpu failed during shutdown: %s", e)

    _emb_fn = None

    try:
        system = getattr(client_db, "_system", None)
        if system is not None:
            system.stop()
    except Exception as e:
        log.debug("Chroma system.stop failed during shutdown: %s", e)

    gc.collect()

def _get_embedding_fn():
    """Returnează funcția de embedding (singleton). Folosit de colecție + semantic guard."""
    global _emb_fn
    if _emb_fn is not None:
        return _emb_fn
    # Suppress "Loading weights" progress bar and "LOAD REPORT" / UNEXPECTED warnings
    try:
        from transformers.utils.logging import disable_progress_bars
        disable_progress_bars()
    except ImportError:
        pass  # transformers not installed or older version without this util
    logging.getLogger("transformers.utils.loading_report").setLevel(logging.ERROR)
    model_name = CFG["librarian"].get("model_name", "") or "sentence-transformers/paraphrase-multilingual-mpnet-base-v2"
    try:
        _emb_fn = embedding_functions.SentenceTransformerEmbeddingFunction(model_name=model_name)
        # Validate: model.encode() uses .tokenize internally; if tokenizer is None we get AttributeError
        try:
            _emb_fn(["test"])
        except AttributeError as ae:
            if "tokenize" in str(ae).lower():
                logging.getLogger("storage").warning(
                    f"Embedding model has no tokenizer ({ae}). Using fallback."
                )
                _emb_fn = None
            else:
                raise
        if _emb_fn is not None:
            logging.getLogger("storage").info(f"Embedding model loaded: {model_name}")
        else:
            # Inner tokenize check set _emb_fn to None — try the explicit fallback model
            raise RuntimeError(f"Primary model '{model_name}' passed init but failed validation")
    except Exception as e:
        logging.getLogger("storage").warning(f"Failed to load {model_name}: {e}. Falling back to all-MiniLM-L6-v2 (English only!)")
        try:
            _emb_fn = embedding_functions.SentenceTransformerEmbeddingFunction(
                model_name="sentence-transformers/all-MiniLM-L6-v2"
            )
            try:
                _emb_fn(["test"])
            except AttributeError as ae:
                if "tokenize" in str(ae).lower():
                    _emb_fn = None
                else:
                    raise
        except Exception:
            _emb_fn = None

    # If embedding function is still None, provide a lightweight deterministic fallback
    if _emb_fn is None:
        logging.getLogger("storage").warning("Using fallback deterministic embedding function (not semantic).")

        class _FallbackEmbedding:
            def __init__(self, dim=64):
                self.dim = dim
                self._is_fallback = True

            def __call__(self, input):
                out = []
                for t in input:
                    if t is None:
                        t = ""
                    h = hashlib.sha256(t.encode('utf-8')).digest()
                    vec = []
                    # Expand/contract digest into dim floats
                    for i in range(self.dim):
                        b = h[i % len(h)]
                        vec.append((b / 255.0) * 2.0 - 1.0)
                    out.append(vec)
                return out

            def embed_query(self, input):
                """ChromaDB 0.4.16+ uses this for query embedding. input can be list of str or single str."""
                if isinstance(input, str):
                    input = [input]
                return self(input)

            def tokenize(self, text):
                if not isinstance(text, str):
                    return []
                return text.split()

            def name(self):
                return "fallback_embedding"

        _emb_fn = _FallbackEmbedding(dim=64)
    return _emb_fn


def _is_fallback_embedding():
    """True if current embedding is the deterministic fallback (used to pick collection name)."""
    fn = _get_embedding_fn()
    return getattr(fn, "_is_fallback", False)


def get_collection():
    global collection
    emb_fn = _get_embedding_fn()
    # ChromaDB does not allow changing embedding function on an existing collection.
    # When we fall back to the deterministic embedder, use a separate collection so we don't conflict
    # with the existing one that was created with sentence_transformer.
    name = "user_memory_fallback" if _is_fallback_embedding() else "user_memory"
    coll = client_db.get_or_create_collection(
        name=name,
        embedding_function=emb_fn
    )
    # Dimension mismatch guard: if the collection was created with a different
    # embedding model, queries will fail. Detect and auto-fix by recreating.
    if coll.count() > 0:
        try:
            coll.query(query_texts=["dimension_check"], n_results=1)
        except Exception as e:
            if "dimension" in str(e).lower():
                _log = logging.getLogger("storage")
                _log.warning(f"Embedding dimension mismatch detected in '{name}'. Recreating collection...")
                # Backup existing data
                data = coll.get()
                client_db.delete_collection(name)
                coll = client_db.create_collection(name=name, embedding_function=emb_fn)
                if data["ids"]:
                    coll.add(ids=data["ids"], documents=data["documents"], metadatas=data["metadatas"])
                    _log.info(f"Re-inserted {len(data['ids'])} documents with correct embeddings")
            else:
                raise
    # Keep the module-level `collection` in sync so all importers see the live reference
    collection = coll
    return coll

def compute_embeddings(texts: list[str]):
    """Returnează embeddings pentru o listă de texte. Folosește același model ca ChromaDB."""
    fn = _get_embedding_fn()
    if fn is None:
        return None
    return fn(texts)


def get_collection_health() -> dict:
    """Return metadata about the current memory collection for health checks."""
    fallback = _is_fallback_embedding()
    name = "user_memory_fallback" if fallback else "user_memory"
    return {
        "status": "ok",
        "collection_name": name,
        "mode": "fallback" if fallback else "primary",
        "embedding": "deterministic_fallback" if fallback else "sentence_transformer",
        "last_error": None,
    }


collection = get_collection()

# --- SESSIONS (JSON) ---
SESSIONS_DIR = os.path.realpath("sessions")
if not os.path.exists(SESSIONS_DIR):
    os.makedirs(SESSIONS_DIR)

# Allow only UUID-like session IDs (hex + optional hyphens) to prevent path traversal
_RE_SAFE_SESSION_ID = re.compile(r"^[0-9a-fA-F\-]{32,36}$")

def _validate_session_path(session_id: str) -> str:
    """Return normalized path under SESSIONS_DIR if session_id is safe; else raise ValueError."""
    if not session_id or not _RE_SAFE_SESSION_ID.match(session_id.strip()):
        raise ValueError("Invalid session_id: must be UUID format")
    base = os.path.realpath(SESSIONS_DIR)
    path = os.path.realpath(os.path.join(SESSIONS_DIR, f"{session_id.strip()}.json"))
    if not path.startswith(base):
        raise ValueError("Invalid session_id: path outside sessions directory")
    return path

def get_session(session_id):
    if not session_id:
        return None
    try:
        path = _validate_session_path(session_id)
    except ValueError:
        return None
    if os.path.exists(path):
        with open(path, "r") as f:
            return json.load(f)
    return None

def create_session(user_id=None):
    sid = str(uuid.uuid4())
    data = {"id": sid, "title": "New Chat", "created_at": time.time(), "messages": [], "user_id": user_id}
    save_session(sid, data)
    return data

def save_session(session_id, data):
    path = _validate_session_path(session_id)
    tmp_path = path + ".tmp"
    with open(tmp_path, "w") as f:
        json.dump(data, f, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp_path, path)

def list_all_sessions(user_id=None, limit=100, offset=0):
    """Listează sesiunile. Dacă user_id e dat, doar cele ale acelui user (sau orfane). limit/offset pentru paginare."""
    sessions = []
    limit = max(1, min(500, int(limit)))
    offset = max(0, int(offset))
    for f in glob.glob(os.path.join(SESSIONS_DIR, "*.json")):
        try:
            with open(f, "r") as file:
                d = json.load(file)
                owner_id = d.get("user_id")
                if user_id is not None and owner_id is not None and owner_id != user_id:
                    continue
                sessions.append({"id": d["id"], "title": d.get("title", "Untitled"), "created_at": d.get("created_at", 0)})
        except Exception as e:
            logging.getLogger("storage").debug(f"Skipping corrupt session file {f}: {e}")
    sessions.sort(key=lambda x: x["created_at"], reverse=True)
    return sessions[offset:offset + limit]

def delete_session_file(session_id):
    try:
        path = _validate_session_path(session_id)
    except ValueError:
        return
    if os.path.exists(path):
        os.remove(path)


def get_latest_session(user_id):
    """Find the most recently modified session for a user. Returns session dict or None."""
    if user_id is None:
        return None
    best = None
    best_time = 0
    for f in glob.glob(os.path.join(SESSIONS_DIR, "*.json")):
        try:
            mtime = os.path.getmtime(f)
            if mtime <= best_time:
                continue
            with open(f, "r") as file:
                d = json.load(file)
            owner_id = d.get("user_id")
            if owner_id is not None and owner_id != user_id:
                continue
            best = d
            best_time = mtime
        except Exception:
            pass
    return best


def append_notification_to_session(user_id, message, notification_id=None, notification_type="reminder"):
    """Append a notification/reminder message to the user's latest session.
    Creates a new session if none exists. Returns the session_id used."""
    import time as _time
    # Find or create session
    session = get_latest_session(user_id)
    if not session:
        session = create_session(user_id=user_id)

    # Append notification as an assistant message with a special marker
    entry = {
        "role": "assistant",
        "content": message,
        "timestamp": _time.time(),
        "notification": True,
        "notification_id": notification_id or f"notif_{_time.time()}",
        "model_name": "Memini",
    }
    if notification_type == "automation":
        entry["automation"] = True
    session["messages"].append(entry)
    save_session(session["id"], session)
    return session["id"]

