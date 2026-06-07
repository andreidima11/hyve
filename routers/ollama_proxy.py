"""Ollama-compatible API endpoint for the Bridge (with optional memory injection)."""
from __future__ import annotations

import asyncio
import json
import re
import time
import httpx
from fastapi import APIRouter, Request, HTTPException
from fastapi.responses import StreamingResponse, JSONResponse

import settings
import assist_keys
import memory_context
import brain
from logger import log_conversation_start

# Under /ollama for when user sets base URL to http://bridge:8082/ollama
router = APIRouter(prefix="/ollama", tags=["ollama"])

# Validare cheie assist în path: hab_ + hex, max 128 caractere
ASSIST_KEY_PATTERN = re.compile(r"^hab_[a-f0-9]{32,64}$")
ASSIST_KEY_MAX_LEN = 128


def _validate_assist_key(key: str) -> bool:
    if not key or len(key) > ASSIST_KEY_MAX_LEN:
        return False
    return bool(ASSIST_KEY_PATTERN.match(key.strip()))

_MEMORY_SYSTEM_PREFIX = (
    "The following are known facts about the user (from Memini memory). "
    "Use them to personalize answers when relevant.\n\n"
)


def _get_memory_context_for_messages(messages: list, user_id: str) -> str:
    user_text = ""
    prev_parts = []
    for m in messages:
        role = (m.get("role") or "").strip().lower()
        content = (m.get("content") or "")
        if isinstance(content, list):
            content = " ".join((c.get("text") or "") for c in content if isinstance(c, dict))
        if role == "user":
            user_text = content
        elif role in ("assistant", "system"):
            prev_parts.append(str(content)[:500])
    prev_context = " ".join(prev_parts[-2:]) if prev_parts else ""
    if not user_text or len(user_text) < 2:
        user_text = "user preferences identity and facts"
    return memory_context.get_memory_context(user_text, prev_context, str(user_id))


def _inject_memories_into_messages(messages: list, memory_text: str) -> list:
    if not memory_text or not memory_text.strip():
        return messages
    block = _MEMORY_SYSTEM_PREFIX + memory_text.strip()
    out = []
    injected = False
    for m in messages:
        role = (m.get("role") or "").strip().lower()
        content = m.get("content") or ""
        if not injected and role == "system":
            out.append({**m, "content": block + "\n\n---\n\n" + (content if isinstance(content, str) else "")})
            injected = True
        else:
            out.append(dict(m))
    if not injected:
        out.insert(0, {"role": "system", "content": block})
    return out


def _ollama_messages_to_openai(messages: list) -> list:
    return [{"role": (m.get("role") or "user").strip().lower(), "content": m.get("content") or ""} for m in messages]


def _sanitize_bridge_history_content(content: object, max_len: int = 4000) -> str:
    if isinstance(content, list):
        content = " ".join((c.get("text") or "") for c in content if isinstance(c, dict))
    text = str(content or "")
    text = re.sub(r"<think>[\s\S]*?</think>", "", text, flags=re.IGNORECASE)
    text = re.sub(r"<thinking>[\s\S]*?</thinking>", "", text, flags=re.IGNORECASE)
    text = text.replace("\x00", " ").strip()
    if len(text) > max_len:
        text = text[:max_len].rstrip() + " ...[truncated]"
    return text


def _openai_content_to_ollama_message(content: str) -> dict:
    return {"role": "assistant", "content": content or ""}


@router.get("/api/tags")
async def list_models():
    """Ollama GET /api/tags: list models. Returns the single model configured in Bridge LLM settings."""
    llm_cfg = settings.CFG.get("llm") or {}
    model_name = (llm_cfg.get("model_name") or "bridge").strip() or "bridge"
    return {
        "models": [
            {
                "name": model_name,
                "model": model_name,
                "modified_at": "2020-01-01T00:00:00Z",
                "size": 0,
                "digest": "",
                "details": {"format": "bridge", "family": "bridge"},
            }
        ]
    }


async def chat_handle(
    request: Request,
    body: dict,
    forced_user_id: int | None = None,
    *,
    allow_anonymous: bool = False,
):
    """Ollama-format chat: body has model, messages[, stream]. Proxies to LLM and optionally injects memories. Call this with pre-parsed body (e.g. from main dispatch)."""
    import auth as auth_mod
    import database

    messages = body.get("messages")
    if not messages or not isinstance(messages, list):
        raise HTTPException(status_code=400, detail="messages array required")

    model = (body.get("model") or "").strip() or "bridge"
    stream = body.get("stream") is not False  # Ollama defaults to true

    assist_cfg = settings.CFG.get("assist") or {}
    user_id = forced_user_id
    if user_id is None:
        db = next(database.get_db())
        try:
            try:
                user_id = await auth_mod.resolve_assist_user_id(request, db)
            except HTTPException as exc:
                if allow_anonymous and exc.status_code == 401:
                    user_id = None
                else:
                    raise
        finally:
            db.close()

    use_bridge_agent = bool(assist_cfg.get("assist_use_bridge_agent", True)) and user_id is not None
    bridge_user_id = f"user_{user_id}" if user_id else "web_assist"

    if use_bridge_agent:
        # Run through Bridge agent: full tools (HA, memory, search, etc.) and same context as web chat
        last = messages[-1] if messages else {}
        user_msg = (last.get("content") or "") if last.get("role") == "user" else ""
        history = []
        for m in messages[:-1]:
            role = (m.get("role") or "user").strip().lower()
            if role not in ("user", "assistant", "system"):
                continue
            content = _sanitize_bridge_history_content(m.get("content") or "")
            history.append({"role": role, "content": content})

        log_conversation_start("ha", bridge_user_id, user_msg or "[no message]")

        async def _agent_stream():
            full_content = ""
            try:
                async for chunk in brain.generate_response_stream(
                    user_msg, history, bridge_user_id,
                    persona_override=None,
                    conversation_summary=None,
                    image_base64=None,
                    is_anonymous=False,
                ):
                    if isinstance(chunk, dict):
                        if chunk.get("t") == "clear_content":
                            full_content = ""
                            continue
                        continue
                    # Skip empty / whitespace-only leading chunks (e.g. newlines after </think>)
                    if not full_content:
                        chunk = chunk.lstrip("\n\r")
                        if not chunk:
                            continue
                    full_content += chunk
                    yield json.dumps({
                        "model": model,
                        "message": {"role": "assistant", "content": chunk},
                        "done": False,
                    }) + "\n"
                yield json.dumps({
                    "model": model,
                    "created_at": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
                    "message": {"role": "assistant", "content": ""},
                    "done": True,
                    "done_reason": "stop",
                }) + "\n"
                from task_utils import create_tracked_task
                create_tracked_task(brain.process_memory_pipeline(user_msg, bridge_user_id, brain.strip_think(full_content)), name="memory_pipeline_ollama")
            except Exception as e:
                err_msg = str(e)[:200]
                yield json.dumps({"model": model, "message": {"role": "assistant", "content": f"Error: {err_msg}"}, "done": True, "error": err_msg}) + "\n"

        return StreamingResponse(
            _agent_stream(),
            media_type="application/x-ndjson",
        )

    # Proxy path: only forward to LLM (no Bridge tools)
    openai_messages = _ollama_messages_to_openai(messages)
    if user_id is not None:
        memory_text = _get_memory_context_for_messages(openai_messages, str(user_id))
        if memory_text:
            openai_messages = _inject_memories_into_messages(openai_messages, memory_text)

    llm_cfg = settings.CFG.get("llm") or {}
    target_url = (llm_cfg.get("target_url") or "").strip()
    if not target_url:
        raise HTTPException(status_code=503, detail="LLM target_url not configured (Settings → LLM)")
    timeout = float(llm_cfg.get("timeout") or 120)
    openai_body = {
        "model": (llm_cfg.get("model_name") or model),
        "messages": openai_messages,
        "stream": stream,
        "temperature": float(llm_cfg.get("temperature", 0.7)),
    }
    if body.get("tools"):
        openai_body["tools"] = body["tools"]
    if body.get("tool_choice") is not None:
        openai_body["tool_choice"] = body["tool_choice"]

    if stream:
        shared_client = getattr(request.app.state, "http_client", None)

        async def _stream():
            client = shared_client if shared_client is not None else httpx.AsyncClient(timeout=timeout)
            own_client = client is not shared_client
            try:
                async with client.stream("POST", target_url, json=openai_body) as resp:
                    if resp.status_code >= 400:
                        err = await resp.aread()
                        yield json.dumps({"error": err.decode()}) + "\n"
                        return
                    full_content = []
                    async for line in resp.aiter_lines():
                        if not line or not line.startswith("data: "):
                            continue
                        data = line[6:].strip()
                        if data == "[DONE]":
                            break
                        try:
                            chunk = json.loads(data)
                            delta = (chunk.get("choices") or [{}])[0].get("delta") or {}
                            piece = delta.get("content") or ""
                            if piece:
                                full_content.append(piece)
                                yield json.dumps({
                                    "model": model,
                                    "message": {"role": "assistant", "content": piece},
                                    "done": False,
                                }) + "\n"
                        except Exception:
                            pass
                    yield json.dumps({
                        "model": model,
                        "created_at": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
                        "message": {"role": "assistant", "content": ""},
                        "done": True,
                        "done_reason": "stop",
                    }) + "\n"
                    # Memory extraction for proxy path
                    if full_content and user_id is not None:
                        try:
                            from brain import cortex as brain_mod
                            last_user_msg = ""
                            for m in reversed(messages):
                                if (m.get("role") or "").lower() == "user":
                                    last_user_msg = m.get("content") or ""
                                    break
                            full_text = "".join(full_content)
                            from task_utils import create_tracked_task
                            create_tracked_task(brain_mod.process_memory_pipeline(last_user_msg, bridge_user_id, brain_mod.strip_think(full_text)), name="memory_pipeline_ollama_proxy")
                        except Exception:
                            pass
            except httpx.TimeoutException:
                yield json.dumps({"error": "LLM request timed out"}) + "\n"
            except httpx.RequestError as e:
                yield json.dumps({"error": str(e)[:200]}) + "\n"
            except Exception as e:
                yield json.dumps({"error": str(e)[:200]}) + "\n"
            finally:
                if own_client:
                    await client.aclose()

        return StreamingResponse(
            _stream(),
            media_type="application/x-ndjson",
        )

    _client = getattr(request.app.state, "http_client", None)
    own_client = _client is None
    if _client is None:
        _client = httpx.AsyncClient(timeout=timeout)
    try:
        try:
            resp = await _client.post(target_url, json=openai_body)
        except httpx.TimeoutException:
            raise HTTPException(status_code=504, detail="LLM request timed out")
        except httpx.RequestError as e:
            raise HTTPException(status_code=502, detail=f"LLM request failed: {e!s}")
    finally:
        if own_client:
            await _client.aclose()

    if resp.status_code >= 400:
        return JSONResponse(
            content=resp.json() if "application/json" in (resp.headers.get("content-type") or "") else {"error": resp.text},
            status_code=resp.status_code,
        )

    data = resp.json()
    content = ""
    for choice in data.get("choices") or []:
        content += (choice.get("message") or {}).get("content") or ""

    # Memory extraction for non-streaming proxy path
    if content and user_id is not None:
        try:
            from brain import cortex as brain_mod
            last_user_msg = ""
            for m in reversed(messages):
                if (m.get("role") or "").lower() == "user":
                    last_user_msg = m.get("content") or ""
                    break
            from task_utils import create_tracked_task
            create_tracked_task(brain_mod.process_memory_pipeline(last_user_msg, bridge_user_id, brain_mod.strip_think(content)), name="memory_pipeline_ollama_nostream")
        except Exception:
            pass

    return {
        "model": model,
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
        "message": {"role": "assistant", "content": content},
        "done": True,
        "done_reason": "stop",
    }


@router.post("/api/chat")
async def chat(request: Request):
    """Ollama POST /api/chat (under /ollama prefix).
    Requires X-Assist-Key header OR proxy_unauthenticated=true in config."""
    proxy_cfg = settings.CFG.get("proxy", {})
    allow_anonymous = bool(proxy_cfg.get("allow_unauthenticated", False))
    forced_user_id: int | None = None
    assist_key = (request.headers.get("x-assist-key") or "").strip()
    if assist_key:
        forced_user_id = assist_keys.get_user_id_by_token(assist_key)
        if forced_user_id is None:
            raise HTTPException(status_code=401, detail="Invalid assist key")
    elif not allow_anonymous:
        raise HTTPException(
            status_code=401,
            detail="Authentication required. Set X-Assist-Key header or enable proxy.allow_unauthenticated in config.",
        )
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")
    return await chat_handle(request, body, forced_user_id=forced_user_id, allow_anonymous=allow_anonymous)


@router.get("/user/{key}/api/tags")
async def list_models_by_key(key: str):
    """Ollama GET /ollama/user/<assist_key>/api/tags. Key in URL identifies the user (no separate API key needed)."""
    if not _validate_assist_key(key):
        raise HTTPException(status_code=400, detail="Invalid assist key format")
    user_id = assist_keys.get_user_id_by_token(key)
    if user_id is None:
        raise HTTPException(status_code=404, detail="Invalid or unknown assist key")
    return await list_models()


@router.post("/user/{key}/api/chat")
async def chat_by_key(request: Request, key: str):
    """Ollama POST /ollama/user/<assist_key>/api/chat. Key in URL identifies the user (no separate API key needed)."""
    if not _validate_assist_key(key):
        raise HTTPException(status_code=400, detail="Invalid assist key format")
    user_id = assist_keys.get_user_id_by_token(key)
    if user_id is None:
        raise HTTPException(status_code=404, detail="Invalid or unknown assist key")
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")
    return await chat_handle(request, body, forced_user_id=user_id)
