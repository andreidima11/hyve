"""Web chat SSE endpoint and document text extraction."""

from __future__ import annotations

import asyncio
import json
import time
import traceback
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, File, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

import auth
import brain
import database
import models
import settings
import storage
from core.auto_router_stats import record_auto_router_usage
from core.chat_helpers import (
    build_llm_override,
    build_session_history,
    select_profile_for_auto,
)
from core.http.limiter import limiter
from core.json_fast import jdumps as _jdumps
from core.log_stream import log_conversation_reply, log_conversation_start, log_detail, log_line
from core.media_utils import extract_document_text as _extract_document_text
from core.post_response import PostResponseManager
from core.request_media import validate_incoming_image_base64
from routers.ollama_proxy import chat_handle as ollama_chat_handle

router = APIRouter(tags=["chat"])

post_response_manager = PostResponseManager(log_line)


class ChatRequest(BaseModel):
    message: str = Field(..., min_length=0, max_length=50000)
    session_id: Optional[str] = Field(None, max_length=128)
    token: Optional[str] = Field(None, max_length=2048)
    image: Optional[str] = Field(None, max_length=4_000_000)
    document_text: Optional[str] = Field(None, max_length=200_000)
    thinking_mode: Optional[str] = Field("auto", max_length=16)


@router.post("/api/extract-document")
@limiter.limit("20/minute")
async def api_extract_document(request: Request, file: UploadFile = File(...), _: models.User = Depends(auth.get_current_user)):
    """Extract text from uploaded PDF, TXT, or DOCX. Returns { \"text\": \"...\" }."""
    try:
        data = await file.read()
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to read file: {e}")
    if len(data) > 10 * 1024 * 1024:  # 10 MB
        raise HTTPException(status_code=400, detail="File too large (max 10 MB)")
    try:
        text = _extract_document_text(data, file.filename or "")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return JSONResponse(content={"text": text})


# --- WEB CHAT (AUTH SUPPORT) ---
@router.post("/api/chat")
@limiter.limit("30/minute")
async def api_chat(request: Request, background_tasks: BackgroundTasks, db: Session = Depends(database.get_db)):
    """Single /api/chat: Ollama-format (HA Assist) → proxy; else Bridge web chat."""
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")
    # HA Ollama/Assist sends { model, messages, stream, tools, ... }
    if isinstance(body.get("messages"), list) and body.get("model") is not None:
        user_id = await auth.resolve_assist_user_id(request, db)
        return await ollama_chat_handle(request, body, forced_user_id=user_id)
    # Bridge web UI sends { message, session_id?, token?, image? }
    try:
        req = ChatRequest(
            message=body.get("message") or "",
            session_id=body.get("session_id"),
            token=body.get("token"),
            image=body.get("image"),
            document_text=body.get("document_text"),
            thinking_mode=body.get("thinking_mode") or "auto",
        )
    except Exception:
        raise HTTPException(status_code=422, detail="Invalid chat request body")
    return await chat_web_impl(request, req, background_tasks, db)


async def chat_web_impl(request: Request, req: ChatRequest, background_tasks: BackgroundTasks, db: Session):
    try:
        token = req.token or (request.headers.get("Authorization") or "").replace("Bearer ", "").strip()
        user_obj = None
        if token:
            try:
                from jose import jwt
                payload = jwt.decode(token, auth.SECRET_KEY, algorithms=[auth.ALGORITHM])
                username = payload.get("sub")
                if username:
                    # Check token revocation
                    jti = payload.get("jti", "")
                    if jti and db.query(models.RevokedToken).filter(models.RevokedToken.jti == jti).first():
                        raise HTTPException(status_code=401, detail="Token revoked")
                    user_obj = db.query(models.User).filter(models.User.username == username).first()
            except HTTPException:
                raise
            except Exception:  # Invalid/expired token — reject
                raise HTTPException(status_code=401, detail="Invalid or expired token")

        if not user_obj:
            raise HTTPException(status_code=401, detail="Authentication required")

        session_user_id = user_obj.id
        session = storage.get_session(req.session_id) if req.session_id else None
        if session and session.get("user_id") is not None and session.get("user_id") != session_user_id:
            session = None
        if not session:
            session = storage.create_session(user_id=session_user_id)
            log_line("sys", "📂", "SESSION", f"New session {session['id'][:8]}... for user_id={session_user_id or 'anon'}")

        user_id = f"user_{user_obj.id}" if user_obj else f"web_{session['id'][:8]}"
        # Prepend attached document text so the model has full context
        effective_message = (req.message or "").strip()
        if (req.document_text or "").strip():
            effective_message = ("User attached a document:\n\n" + (req.document_text or "").strip() + "\n\n" + effective_message).strip()
        msg_preview = effective_message[:80] or ("[image]" if req.image else "")
        working_window = settings.CFG.get("memory", {}).get("working_window", 12)
        # Include full message structure (tool_calls, tool role) so the model sees prior tool-use
        history = build_session_history(session["messages"], working_window)
        log_conversation_start("web", user_id, effective_message or "[image]", has_image=bool(req.image))
        log_detail("api", "CHAT_START", session_id=session["id"], user_id=user_id, msg_len=len(req.message or ""), has_image=bool(req.image), history_len=len(history))
        conversation_summary = session.get("summary") or ""
        persona = user_obj.persona_override if user_obj else None
        user_profile_context = None
        if user_obj:
            from core.user_profile import build_user_profile_context
            user_profile_context = build_user_profile_context(user_obj)

        from brain.thinking_control import normalize_thinking_mode
        thinking_mode = normalize_thinking_mode(req.thinking_mode)

        # Per-user default profile: use it for this request if set
        llm_override = None
        effective_profile_name = None
        is_auto_selection = False
        ordered_auto_ids = []
        profile = None
        if user_obj and getattr(user_obj, "default_profile_id", None):
            profiles = settings.CFG.get("model_profiles") or []
            profile_id_to_use = user_obj.default_profile_id
            if (profile_id_to_use or "").strip().lower() == "auto":
                ordered_auto_ids, auto_reason = select_profile_for_auto(
                    has_image=bool(req.image),
                    has_document=bool((req.document_text or "").strip()),
                    profiles=profiles,
                    message_length=len(req.message or ""),
                    history_message_count=len(history),
                )
                profile_id_to_use = ordered_auto_ids[0] if ordered_auto_ids else None
                if profile_id_to_use:
                    log_detail("api", "AUTO_PROFILE", profile_id=profile_id_to_use, reason=auto_reason)
                    is_auto_selection = True
            profile = next((p for p in profiles if p.get("id") == profile_id_to_use), None) if profile_id_to_use else None
            if profile:
                llm_override = build_llm_override(profile)
                effective_profile_name = (profile.get("name") or "").strip() or (profile.get("model_name") or "?")
                profile_persona = (profile.get("persona_override") or "").strip() or None
                if profile_persona:
                    persona = profile_persona
        if effective_profile_name is None:
            effective_profile_name = settings.get_active_profile_name()

        sec_cfg = settings.CFG.get("security") or {}
        max_image_bytes = int(sec_cfg.get("uploaded_image_max_bytes") or 3_000_000)
        req.image = validate_incoming_image_base64(req.image, max_bytes=max_image_bytes)

        # ── TIER 1: Regex fast-path (instant, single command) ────────
        direct_reply = None
        if not req.image and not (req.document_text or "").strip() and effective_message and len(effective_message) <= 250:
            try:
                from direct_commands import try_regex_command
                direct_reply = await try_regex_command(effective_message, user_id)
            except Exception as e:
                log_line("error", "⚠️", "REGEX_CMD", str(e))

        # ── Intent router: classify message ──────────────────────────
        routed_intent = None
        if direct_reply is None and effective_message:
            try:
                from intent_router import classify_intent, INTENT_DEVICE_CONTROL
                routed_intent, router_ms = await classify_intent(
                    effective_message,
                    has_image=bool(req.image),
                    has_document=bool((req.document_text or "").strip()),
                )
            except Exception as e:
                log_line("error", "⚠️", "INTENT_ROUTER", str(e))

        # ── TIER 2: Semantic extraction (only if device_control) ─────
        if direct_reply is None and routed_intent == "device_control":
            try:
                from direct_commands import try_semantic_commands
                direct_reply = await try_semantic_commands(effective_message, user_id)
            except Exception as e:
                log_line("error", "⚠️", "SEMANTIC_CMD", str(e))

        # ── COMPOUND: mixed device + other intent ────────────────────
        compound_ha_reply = None
        if direct_reply is None and routed_intent == "compound":
            # Try Tier 1 (regex) on the full message — it can extract device parts
            try:
                from direct_commands import try_regex_command
                compound_ha_reply = await try_regex_command(effective_message, user_id)
            except Exception:
                pass
            # If regex didn't find anything, try Tier 2 (semantic)
            if not compound_ha_reply:
                try:
                    from direct_commands import try_semantic_commands
                    compound_ha_reply = await try_semantic_commands(effective_message, user_id)
                except Exception:
                    pass
            # Don't set direct_reply — let the agent handle the rest
            # The HA result will be prepended to the agent's response
            routed_intent = "complex"  # fall through to agent for the non-HA part

        async def response_generator():
            full_response = ""
            full_thinking = ""
            history_messages = None
            last_search_sources = []
            last_forge_preview = ""
            last_forge_preview_language = "python"
            used_profile_color = (profile.get("color") or "").strip() or "#38bdf8" if profile else None
            used_model_name = effective_profile_name or ""
            used_model_id = (profile.get("model_name") or "").strip() if profile else ""

            # Human-like streaming pacing (configurable delay between chunks)
            _pacing_cfg = (settings.CFG.get("intelligence") or {})
            _stream_pace_ms = float(_pacing_cfg.get("stream_pace_ms", 0) or 0)
            _stream_pace_sec = max(0.0, _stream_pace_ms / 1000.0) if _stream_pace_ms > 0 else 0.0

            if direct_reply is not None:
                # Răspuns direct (comandă aprinde/stinge etc.) — fără agent
                full_response = direct_reply
                yield f"event: chunk\ndata: {json.dumps(direct_reply)}\n\n"
                yield f"event: final_message\ndata: {_jdumps({'thinking': '', 'content': direct_reply, 'model': used_model_name, 'model_id': used_model_id})}\n\n"
            else:
                # If compound intent resolved HA commands, prepend that to the stream
                if compound_ha_reply:
                    ha_prefix = compound_ha_reply + "\n\n"
                    full_response += ha_prefix
                    yield f"event: chunk\ndata: {_jdumps(ha_prefix)}\n\n"
                used_auto_profile_id = None
                last_fallback_error = None
                if is_auto_selection and ordered_auto_ids:
                    for profile_id in ordered_auto_ids:
                        profile_try = next((p for p in profiles if p.get("id") == profile_id), None)
                        if not profile_try:
                            continue
                        try_override = build_llm_override(profile_try)
                        try_persona = (profile_try.get("persona_override") or "").strip() or persona
                        try:
                            async for chunk in brain.generate_response_stream(
                                effective_message, history, user_id,
                                persona_override=try_persona,
                                conversation_summary=conversation_summary,
                                image_base64=req.image,
                                llm_override=try_override,
                                is_anonymous=(user_obj is None),
                                routed_intent=routed_intent,
                                user_profile_context=user_profile_context,
                                thinking_mode=thinking_mode,
                            ):
                                if isinstance(chunk, dict):
                                    if chunk.get("t") == "history_messages":
                                        history_messages = chunk.get("messages", [])
                                        continue
                                    if chunk.get("t") == "thinking":
                                        c = chunk.get("content", "") or ""
                                        full_thinking += c
                                        yield f"event: thinking\ndata: {_jdumps({'content': c})}\n\n"
                                        continue
                                    if chunk.get("t") == "status":
                                        payload = {"type": chunk.get("type", ""), "label": chunk.get("label", "")}
                                        if chunk.get("labelKey") is not None:
                                            payload["labelKey"] = chunk["labelKey"]
                                        if chunk.get("params"):
                                            payload["params"] = chunk["params"]
                                        yield f"event: status\ndata: {_jdumps(payload)}\n\n"
                                        continue
                                    if chunk.get("t") == "shell_done":
                                        yield f"event: shell_done\ndata: {_jdumps({'command': chunk.get('command', ''), 'exit_code': chunk.get('exit_code'), 'output_preview': chunk.get('output_preview', '')})}\n\n"
                                        continue
                                    if chunk.get("t") == "shell_request":
                                        yield f"event: shell_request\ndata: {_jdumps({'command': chunk.get('command', '')})}\n\n"
                                        continue
                                    if chunk.get("t") == "shell_suggest":
                                        yield f"event: shell_suggest\ndata: {_jdumps({'command': chunk.get('command', ''), 'reason': chunk.get('reason', '')})}\n\n"
                                        continue
                                    if chunk.get("t") == "proposal":
                                        yield f"event: proposal\ndata: {_jdumps(chunk.get('proposal', {}))}\n\n"
                                        continue
                                    if chunk.get("t") == "metrics":
                                        payload = {"completion_tokens": chunk.get("completion_tokens"), "prompt_tokens": chunk.get("prompt_tokens"), "total_tokens": chunk.get("total_tokens"), "ttft_ms": chunk.get("ttft_ms"), "llm_elapsed_ms": chunk.get("llm_elapsed_ms"), "total_elapsed_ms": chunk.get("total_elapsed_ms")}
                                        yield f"event: metrics\ndata: {_jdumps(payload)}\n\n"
                                        continue
                                    if chunk.get("t") == "clear_content":
                                        full_response = ""
                                        yield f"event: clear_content\ndata: {{}}\n\n"
                                        continue
                                    if chunk.get("t") == "search_sources":
                                        sources = chunk.get('sources', [])
                                        if isinstance(sources, list):
                                            last_search_sources = sources
                                        yield f"event: search_sources\ndata: {_jdumps({'sources': chunk.get('sources', [])})}\n\n"
                                        continue
                                    if chunk.get("t") == "forge_preview":
                                        last_forge_preview = chunk.get('content', '') or ""
                                        last_forge_preview_language = chunk.get('language', 'python') or 'python'
                                        yield f"event: forge_preview\ndata: {_jdumps({'content': chunk.get('content', ''), 'language': chunk.get('language', 'python'), 'done': bool(chunk.get('done'))})}\n\n"
                                        continue
                                full_response += chunk
                                if _stream_pace_sec > 0:
                                    await asyncio.sleep(_stream_pace_sec)
                                yield f"event: chunk\ndata: {_jdumps(chunk)}\n\n"
                            think_part, content_part = brain.strip_think_content(full_response)
                            if full_thinking.strip():
                                think_part = (think_part.strip() + "\n\n" + full_thinking.strip()).strip() if think_part.strip() else full_thinking.strip()
                            yield f"event: final_message\ndata: {_jdumps({'thinking': think_part, 'content': content_part, 'model': (profile_try.get('name') or profile_try.get('model_name') or '').strip(), 'model_id': (profile_try.get('model_name') or '').strip()})}\n\n"
                            used_auto_profile_id = profile_id
                            used_model_name = (profile_try.get("name") or profile_try.get("model_name") or "").strip()
                            used_model_id = (profile_try.get("model_name") or "").strip()
                            used_profile_color = (profile_try.get("color") or "").strip() or "#38bdf8"
                            if used_profile_color:
                                yield f"event: profile_color\ndata: {_jdumps({'color': used_profile_color})}\n\n"
                            break
                        except Exception as e:
                            last_fallback_error = e
                            log_detail("api", "AUTO_FALLBACK", profile_id=profile_id, error=str(e))
                            continue
                    if used_auto_profile_id:
                        p_used = next((x for x in profiles if x.get("id") == used_auto_profile_id), None)
                        if p_used:
                            record_auto_router_usage("local" if (p_used.get("provider") or "").strip().lower() == "local" else "api")
                    elif last_fallback_error is not None:
                        raise last_fallback_error
                if not (is_auto_selection and ordered_auto_ids):
                    if used_profile_color:
                        yield f"event: profile_color\ndata: {_jdumps({'color': used_profile_color})}\n\n"
                    async for chunk in brain.generate_response_stream(
                            effective_message, history, user_id,
                            persona_override=persona,
                            conversation_summary=conversation_summary,
                            image_base64=req.image,
                            llm_override=llm_override,
                            is_anonymous=(user_obj is None),
                            routed_intent=routed_intent,
                            user_profile_context=user_profile_context,
                            thinking_mode=thinking_mode,
                        ):
                            if isinstance(chunk, dict):
                                if chunk.get("t") == "history_messages":
                                    history_messages = chunk.get("messages", [])
                                    continue
                                if chunk.get("t") == "thinking":
                                    c = chunk.get("content", "") or ""
                                    full_thinking += c
                                    yield f"event: thinking\ndata: {_jdumps({'content': c})}\n\n"
                                    continue
                                if chunk.get("t") == "status":
                                    payload = {"type": chunk.get("type", ""), "label": chunk.get("label", "")}
                                    if chunk.get("labelKey") is not None:
                                        payload["labelKey"] = chunk["labelKey"]
                                    if chunk.get("params"):
                                        payload["params"] = chunk["params"]
                                    yield f"event: status\ndata: {_jdumps(payload)}\n\n"
                                    continue
                                if chunk.get("t") == "shell_done":
                                    yield f"event: shell_done\ndata: {_jdumps({'command': chunk.get('command', ''), 'exit_code': chunk.get('exit_code'), 'output_preview': chunk.get('output_preview', '')})}\n\n"
                                    continue
                                if chunk.get("t") == "shell_request":
                                    yield f"event: shell_request\ndata: {_jdumps({'command': chunk.get('command', '')})}\n\n"
                                    continue
                                if chunk.get("t") == "shell_suggest":
                                    yield f"event: shell_suggest\ndata: {_jdumps({'command': chunk.get('command', ''), 'reason': chunk.get('reason', '')})}\n\n"
                                    continue
                                if chunk.get("t") == "proposal":
                                    yield f"event: proposal\ndata: {_jdumps(chunk.get('proposal', {}))}\n\n"
                                    continue
                                if chunk.get("t") == "metrics":
                                    payload = {
                                        "completion_tokens": chunk.get("completion_tokens"),
                                        "prompt_tokens": chunk.get("prompt_tokens"),
                                        "total_tokens": chunk.get("total_tokens"),
                                        "ttft_ms": chunk.get("ttft_ms"),
                                        "llm_elapsed_ms": chunk.get("llm_elapsed_ms"),
                                        "total_elapsed_ms": chunk.get("total_elapsed_ms"),
                                    }
                                    yield f"event: metrics\ndata: {_jdumps(payload)}\n\n"
                                    continue
                                if chunk.get("t") == "clear_content":
                                    full_response = ""
                                    yield f"event: clear_content\ndata: {{}}\n\n"
                                    continue
                                if chunk.get("t") == "search_sources":
                                    sources = chunk.get('sources', [])
                                    if isinstance(sources, list):
                                        last_search_sources = sources
                                    yield f"event: search_sources\ndata: {_jdumps({'sources': chunk.get('sources', [])})}\n\n"
                                    continue
                                if chunk.get("t") == "forge_preview":
                                    last_forge_preview = chunk.get('content', '') or ""
                                    last_forge_preview_language = chunk.get('language', 'python') or 'python'
                                    yield f"event: forge_preview\ndata: {_jdumps({'content': chunk.get('content', ''), 'language': chunk.get('language', 'python'), 'done': bool(chunk.get('done'))})}\n\n"
                                    continue
                            full_response += chunk
                            if _stream_pace_sec > 0:
                                await asyncio.sleep(_stream_pace_sec)
                            yield f"event: chunk\ndata: {_jdumps(chunk)}\n\n"
                    think_part, content_part = brain.strip_think_content(full_response)
                    if full_thinking.strip():
                        think_part = (think_part.strip() + "\n\n" + full_thinking.strip()).strip() if think_part.strip() else full_thinking.strip()
                    yield f"event: final_message\ndata: {_jdumps({'thinking': think_part, 'content': content_part, 'model': used_model_name, 'model_id': used_model_id})}\n\n"

            user_content = effective_message
            if req.image and not user_content:
                user_content = "[Imagine atașată]"
            session["messages"].append({"role": "user", "content": user_content, "timestamp": time.time()})
            # Compute thinking for persistence
            think_part_save, content_part_save = brain.strip_think_content(full_response)
            if full_thinking.strip():
                think_part_save = (think_part_save.strip() + "\n\n" + full_thinking.strip()).strip() if think_part_save.strip() else full_thinking.strip()

            if history_messages:
                for i, m in enumerate(history_messages):
                    msg = {"role": m.get("role", "assistant"), "content": m.get("content") or ""}
                    if m.get("tool_calls") is not None:
                        msg["tool_calls"] = m["tool_calls"]
                    if m.get("tool_call_id") is not None:
                        msg["tool_call_id"] = m["tool_call_id"]
                    if i == len(history_messages) - 1 and msg.get("role") == "assistant":
                        if used_profile_color:
                            msg["profile_color"] = used_profile_color
                        if used_model_name:
                            msg["model_name"] = used_model_name
                        if used_model_id:
                            msg["model_id"] = used_model_id
                        if think_part_save:
                            msg["thinking"] = think_part_save
                        if last_search_sources:
                            msg["search_sources"] = last_search_sources
                        if m.get("forge_preview"):
                            msg["forge_preview"] = m.get("forge_preview") or ""
                            msg["forge_preview_language"] = m.get("forge_preview_language") or "python"
                        elif last_forge_preview:
                            msg["forge_preview"] = last_forge_preview
                            msg["forge_preview_language"] = last_forge_preview_language
                    session["messages"].append(msg)
            else:
                session["messages"].append({
                    "role": "assistant",
                    "content": content_part_save,
                    "profile_color": used_profile_color,
                    **({"model_name": used_model_name} if used_model_name else {}),
                    **({"model_id": used_model_id} if used_model_id else {}),
                    **({"thinking": think_part_save} if think_part_save else {}),
                    **({"search_sources": last_search_sources} if last_search_sources else {}),
                    **({"forge_preview": last_forge_preview} if last_forge_preview else {}),
                    **({"forge_preview_language": last_forge_preview_language} if last_forge_preview else {}),
                })

            # Titlu automat pentru conversație
            if not session.get("title") or session.get("title") == "New Chat":
                raw_title = (req.message or "").strip()
                if not raw_title and session["messages"]:
                    raw_title = session["messages"][0].get("content", "").strip()
                if raw_title:
                    max_len = 45
                    title = raw_title[:max_len].strip()
                    if len(raw_title) > max_len:
                        title += "..."
                    session["title"] = title

            if session_user_id is not None:
                session["user_id"] = session_user_id
            storage.save_session(session["id"], session)
            log_conversation_reply(full_response, profile_name=effective_profile_name)
            log_detail("api", "CHAT_END", session_id=session["id"], reply_len=len(full_response), messages_in_session=len(session.get("messages", [])))

            # Always run memory pipeline — it handles dedup against existing memories
            # even when store_memory was called (the agent might have captured only one fact
            # while the conversation contained more worth remembering)
            post_response_manager.enqueue(user_id, effective_message or "", brain.strip_think(full_response), session["id"], history, skip_memory_pipeline=False)

        headers = {
            "X-Session-Id": session["id"],
            "Cache-Control": "no-store",
            "X-Accel-Buffering": "no",
            "X-Memory-Status": (storage.get_collection_health().get("status") or "unknown"),
            "X-Memory-Mode": (storage.get_collection_health().get("mode") or "unknown"),
        }
        if profile:
            headers["X-Profile-Color"] = (profile.get("color") or "").strip() or "#38bdf8"
        return StreamingResponse(
            response_generator(),
            media_type="text/event-stream",
            headers=headers,
        )

    except HTTPException:
        raise
    except Exception as e:
        log_line("error", "⚠️", "EXCEPTION", traceback.format_exc())
        return JSONResponse(status_code=500, content={"error": "internal_server_error"})
