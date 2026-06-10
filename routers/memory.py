"""Memory & memory events API routes."""
from typing import Optional, List
from fastapi import APIRouter, Depends, HTTPException, Body, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel
import traceback
import storage
import settings
import models
import auth

import brain
from core.http.errors import error_detail
from core.log_stream import log_line

router = APIRouter(prefix="/api/memory", tags=["memory"])


class MemoryUpdate(BaseModel):
    text: str


class MemoryBulkDelete(BaseModel):
    ids: List[str]


class ConsolidationRunBody(BaseModel):
    """Optional override for manual consolidation run."""
    threshold: Optional[float] = None  # e.g. 0.9 = more aggressive; 0.95 = more conservative
    run_ai_prune: Optional[bool] = None  # if True, also run AI prune (LLM decides what to delete)


@router.get("")
async def get_mem(
    current_user: models.User = Depends(auth.get_current_user),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
):
    try:
        user_id = f"user_{current_user.id}"
        coll = storage.get_collection()
        results = coll.get(limit=limit + offset, where={"$and": [{"type": "fact"}, {"user_id": user_id}]})
        memories = []
        if results['ids']:
            for i, id in enumerate(results['ids']):
                meta = results['metadatas'][i] or {}
                memories.append({
                    "id": id,
                    "document": results['documents'][i],
                    "metadata": meta,
                    "user_id": meta.get("user_id", "Unknown"),
                    "timestamp": meta.get("timestamp", 0)
                })
        memories.sort(key=lambda x: x["timestamp"], reverse=True)
        return memories[offset:offset + limit]
    except Exception as e:
        log_line("error", "❌", "MEM API", str(e))
        return []


@router.put("/{mem_id}")
async def update_mem(mem_id: str, data: MemoryUpdate, current_user: models.User = Depends(auth.get_current_user)):
    try:
        coll = storage.get_collection()
        existing = coll.get(ids=[mem_id], where={"user_id": f"user_{current_user.id}"})
        if not existing or not existing["ids"]:
            raise HTTPException(status_code=404, detail=error_detail("memory.not_found"))
        coll.update(ids=[mem_id], documents=[data.text])
        log_line("mem", "✏️", "EDIT", f"Memory updated: {mem_id}")
        try:
            from core.memory_events import append_event, EVENT_UPDATED
            append_event(EVENT_UPDATED, user_id=f"user_{current_user.id}", summary=data.text[:120] + ("…" if len(data.text) > 120 else ""), details={"fact_id": mem_id})
        except Exception:
            pass
        return {"status": "updated"}
    except HTTPException:
        raise
    except Exception:
        log_line("error", "❌", "MEM API", traceback.format_exc())
        return JSONResponse(status_code=500, content={"error": "internal_server_error"})


@router.post("/bulk_delete")
async def bulk_delete_mem(data: MemoryBulkDelete, current_user: models.User = Depends(auth.get_current_user)):
    if not data.ids:
        return {"status": "ignored"}
    try:
        user_id = f"user_{current_user.id}"
        deleted = 0
        BATCH = 50
        coll = storage.get_collection()
        for i in range(0, len(data.ids), BATCH):
            batch_ids = data.ids[i:i + BATCH]
            existing = coll.get(ids=batch_ids, where={"user_id": user_id})
            owned_ids = existing["ids"] if existing and existing["ids"] else []
            if owned_ids:
                coll.delete(ids=owned_ids)
                deleted += len(owned_ids)
        log_line("mem", "🗑️", "DELETE", f"Deleted {deleted}/{len(data.ids)} memories.")
        try:
            from core.memory_events import append_event, EVENT_DELETED
            append_event(EVENT_DELETED, user_id=user_id, summary=f"{len(data.ids)} items", details={"ids": data.ids})
        except Exception:
            pass
        return {"status": "ok"}
    except Exception:
        log_line("error", "❌", "MEM API", traceback.format_exc())
        return JSONResponse(status_code=500, content={"error": "internal_server_error"})


@router.get("/events")
async def get_memory_events(
    limit: int = 80,
    offset: int = 0,
    event_type: Optional[str] = None,
    current_user: models.User = Depends(auth.get_current_user),
):
    """Memory event log: additions, edits, deletions, consolidation."""
    try:
        from core.memory_events import get_events, get_events_count
        user_id = f"user_{current_user.id}"
        events = get_events(limit=limit, offset=offset, event_type=event_type or None, user_id=user_id)
        total = get_events_count(event_type=event_type or None, user_id=user_id)
        return {"events": events, "total": total}
    except Exception as e:
        log_line("error", "❌", "MEM EVENTS", str(e))
        return {"events": [], "total": 0}


@router.post("/clear_events")
async def clear_memory_log(current_user: models.User = Depends(auth.get_current_user)):
    """Clear all entries from the memory event log."""
    try:
        from core.memory_events import clear_events
        if not clear_events():
            return JSONResponse(status_code=500, content={"error": "Clear failed"})
        log_line("mem", "🗑️", "MEM LOG", "Memory log cleared")
        return {"status": "ok"}
    except Exception:
        log_line("error", "❌", "MEM LOG CLEAR", traceback.format_exc())
        return JSONResponse(status_code=500, content={"error": "internal_server_error"})


@router.post("/consolidation/run")
async def run_consolidation_now(
    body: Optional[ConsolidationRunBody] = Body(None),
    current_user: models.User = Depends(auth.get_current_user),
):
    """Run memory consolidation manually (dedupe + optional AI prune). Body: {"threshold": 0.9, "run_ai_prune": true}."""
    try:
        import asyncio
        from core.memory_maintenance import run_consolidation, run_ai_prune
        settings.reload_config()
        cfg = settings.CFG.get("intelligence", {}).get("consolidation", {})
        default = float(cfg.get("similarity_threshold", 0.92))
        threshold = default if body is None or body.threshold is None else max(0.5, min(0.99, float(body.threshold)))
        result = await asyncio.get_event_loop().run_in_executor(None, run_consolidation, threshold)
        do_ai_prune = cfg.get("ai_prune") or (body and body.run_ai_prune is True)
        if do_ai_prune:
            aux = settings.CFG.get("intelligence", {}).get("aux_llm") or {}
            llm = settings.CFG.get("llm") or {}
            llm_url = (aux.get("target_url") or "").strip() or (llm.get("target_url") or "").strip()
            llm_model = (aux.get("model_name") or "").strip() or (llm.get("model_name") or "").strip()
            if llm_url and llm_model:
                prune_cfg = cfg if cfg.get("ai_prune") else {"ai_prune": True, "ai_prune_max_facts_per_user": int(cfg.get("ai_prune_max_facts_per_user", 50))}
                result["ai_prune"] = await asyncio.get_event_loop().run_in_executor(None, run_ai_prune, prune_cfg, llm_url, llm_model)
        return {"status": "ok", "result": result, "threshold_used": threshold}
    except Exception:
        log_line("error", "❌", "CONSOLIDATION", traceback.format_exc())
        return JSONResponse(status_code=500, content={"error": "internal_server_error"})
