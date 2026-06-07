"""OpenAI-compatible proxy: forwards to LLM and injects Bridge memories."""
from __future__ import annotations

import asyncio
import json
import httpx
from fastapi import APIRouter, Request, HTTPException
from fastapi.responses import StreamingResponse, JSONResponse

import settings
import assist_keys
import memory_context
import brain

router = APIRouter(prefix="/api/openai", tags=["openai"])

_MEMORY_SYSTEM_PREFIX = (
    "The following are known facts about the user (from M\u0115mini memory). "
    "Use them to personalize answers when relevant.\n\n"
)


def _get_memory_context_for_messages(messages: list, user_id: str) -> str:
    """Build query from last user message; return formatted memory string."""
    user_text = ""
    prev_parts = []
    for m in messages:
        role = (m.get("role") or "").strip().lower()
        content = (m.get("content") or "")
        if isinstance(content, list):
            content = " ".join(
                (c.get("text") or "") for c in content if isinstance(c, dict)
            )
        if role == "user":
            user_text = content
        elif role in ("assistant", "system"):
            prev_parts.append(content[:500])
    prev_context = " ".join(prev_parts[-2:]) if prev_parts else ""
    if not user_text or len(user_text) < 2:
        user_text = "user preferences identity and facts"
    return memory_context.get_memory_context(user_text, prev_context, str(user_id))


def _inject_memories_into_messages(messages: list, memory_text: str) -> list:
    """Prepend a system message with memories. If first message is system, prepend to its content."""
    if not memory_text or not memory_text.strip():
        return messages
    block = _MEMORY_SYSTEM_PREFIX + memory_text.strip()
    out = []
    injected = False
    for m in messages:
        role = (m.get("role") or "").strip().lower()
        content = m.get("content") or ""
        if isinstance(content, list):
            content = content  # keep as list for multimodal
        if not injected and role == "system":
            if isinstance(content, str):
                new_content = block + "\n\n---\n\n" + content
            else:
                new_content = content
            out.append({**m, "content": new_content})
            injected = True
        else:
            out.append(dict(m))
    if not injected:
        out.insert(0, {"role": "system", "content": block})
    return out


@router.post("/v1/chat/completions")
async def chat_completions(request: Request):
    """OpenAI Chat Completions–compatible endpoint: proxy to configured LLM and optionally inject memories."""
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")

    messages = body.get("messages")
    if not messages or not isinstance(messages, list):
        raise HTTPException(status_code=400, detail="messages array required")

    # Resolve user from Bearer token (Assist API key) or X-Assist-Key header
    auth_hdr = request.headers.get("Authorization") or ""
    token = None
    if auth_hdr.startswith("Bearer "):
        token = auth_hdr[7:].strip()
    if not token:
        token = (request.headers.get("x-assist-key") or "").strip()
    user_id = assist_keys.get_user_id_by_token(token) if token else None

    # If token provided but invalid, reject
    if user_id is None and token:
        raise HTTPException(status_code=401, detail="Invalid assist key or token")
    # If no token at all, require config opt-in for unauthenticated access
    if user_id is None:
        proxy_cfg = settings.CFG.get("proxy", {})
        if not proxy_cfg.get("allow_unauthenticated", False):
            raise HTTPException(status_code=401, detail="Authentication required. Provide Bearer token or enable proxy.allow_unauthenticated in config.")

    if user_id is not None:
        memory_text = _get_memory_context_for_messages(messages, str(user_id))
        if memory_text:
            messages = _inject_memories_into_messages(messages, memory_text)
            body = {**body, "messages": messages}

    llm_cfg = settings.CFG.get("llm") or {}
    target_url = (llm_cfg.get("target_url") or "").strip()
    if not target_url:
        raise HTTPException(
            status_code=503,
            detail="LLM target_url not configured (Settings → LLM)",
        )
    # Z.AI etc: base URL .../v4 or .../v1 must become .../v4/chat/completions
    if "chat/completions" not in target_url and "chat/" not in target_url:
        base = target_url.rstrip("/")
        if base.endswith("/v4") or base.endswith("/v1"):
            target_url = base + "/chat/completions"
    timeout = float(llm_cfg.get("timeout") or 120)
    api_key = llm_cfg.get("api_key") or ""
    compact_api_key = "".join(str(api_key).split())
    safe_api_key = compact_api_key.encode("ascii", errors="ignore").decode("ascii") if compact_api_key else ""
    llm_headers = {"Authorization": f"Bearer {safe_api_key}"} if safe_api_key else {}
    # Apply Bridge temperature when client did not send one (Local, DeepSeek, Z.AI, OpenAI)
    if "temperature" not in body:
        body = {**body, "temperature": float(llm_cfg.get("temperature", 0.7))}

    stream = body.get("stream") is True
    last_user_msg = ""
    for m in reversed(messages or []):
        if (m.get("role") or "").strip().lower() == "user":
            c = m.get("content") or ""
            last_user_msg = c if isinstance(c, str) else " ".join((x.get("text") or "") for x in c if isinstance(x, dict))
            break
    bridge_user_id = f"user_{user_id}" if user_id is not None else None

    if stream:
        shared_client = getattr(request.app.state, "http_client", None)

        async def _stream_chunks():
            full_content = []
            buf = b""
            client = shared_client if shared_client is not None else httpx.AsyncClient(timeout=timeout)
            own_client = client is not shared_client
            try:
                async with client.stream("POST", target_url, json=body, headers=llm_headers) as resp:
                    if resp.status_code >= 400:
                        err_body = await resp.aread()
                        try:
                            err_json = json.loads(err_body.decode())
                        except Exception:
                            err_json = {"error": err_body.decode()}
                        yield ("data: " + json.dumps({"error": err_json}) + "\n\n").encode()
                        return
                    async for chunk in resp.aiter_bytes():
                        yield chunk
                        if bridge_user_id:
                            buf += chunk
                            while b"\n" in buf:
                                line, _, buf = buf.partition(b"\n")
                                line = line.strip().replace(b"\r", b"")
                                if line.startswith(b"data: "):
                                    payload = line.split(b"data: ", 1)[-1].strip()
                                    if payload != b"[DONE]":
                                        try:
                                            data = json.loads(payload.decode("utf-8"))
                                            delta = (data.get("choices") or [{}])[0].get("delta") or {}
                                            piece = delta.get("content") or ""
                                            if piece:
                                                full_content.append(piece)
                                        except Exception:
                                            pass
            except Exception as e:
                yield ("data: " + json.dumps({"error": {"message": str(e)[:200]}}) + "\n\n").encode()
            finally:
                if own_client:
                    await client.aclose()
            if bridge_user_id and last_user_msg and full_content:
                from task_utils import create_tracked_task
                create_tracked_task(brain.process_memory_pipeline(last_user_msg, bridge_user_id, brain.strip_think("".join(full_content))), name="memory_pipeline_openai")

        return StreamingResponse(
            _stream_chunks(),
            media_type="text/event-stream",
        )

    shared_client = getattr(request.app.state, "http_client", None)
    client = shared_client if shared_client is not None else httpx.AsyncClient(timeout=timeout)
    own_client = client is not shared_client
    try:
        try:
            resp = await client.post(target_url, json=body, headers=llm_headers)
        except httpx.TimeoutException:
            raise HTTPException(status_code=504, detail="LLM request timed out")
        except httpx.RequestError as e:
            raise HTTPException(
                status_code=502,
                detail=f"LLM request failed: {e!s}",
            )
    finally:
        if own_client:
            await client.aclose()

    if resp.status_code >= 400:
        return JSONResponse(
            content=resp.json() if resp.headers.get("content-type", "").startswith("application/json") else {"error": resp.text},
            status_code=resp.status_code,
        )
    data = resp.json()
    if bridge_user_id and last_user_msg:
        content = (data.get("choices") or [{}])[0].get("message", {}).get("content") or ""
        if content:
            from task_utils import create_tracked_task
            create_tracked_task(brain.process_memory_pipeline(last_user_msg, bridge_user_id, brain.strip_think(content)), name="memory_pipeline_openai_nostream")
    return JSONResponse(content=data)
