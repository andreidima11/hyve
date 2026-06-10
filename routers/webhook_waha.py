"""WAHA (WhatsApp HTTP API) inbound webhook."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import os
import traceback

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

import auth
import brain
import database
import models
import settings
from core.http.errors import error_detail
from core.http.limiter import limiter
from core.log_stream import log_conversation_reply, log_conversation_start, log_line
from core.media_utils import (
    extract_markdown_image_urls as _extract_markdown_image_urls,
    strip_markdown_images as _strip_markdown_images,
    waha_download_media_as_base64 as _waha_download_media_as_base64,
    waha_send_image as _waha_send_image,
)
from core.whatsapp_context import whatsapp_context_lock, whatsapp_context_store

router = APIRouter(tags=["webhooks"])

@router.post("/api/webhook/waha")
@limiter.limit("60/minute")
async def waha_hook(request: Request, background_tasks: BackgroundTasks, db: Session = Depends(database.get_db)):
    from integrations import entry_settings

    cfg = settings.CFG
    if not entry_settings.is_active("waha"):
        return {"status": "ignored"}

    # HMAC signature verification is mandatory when WAHA is enabled.
    waha_secret = os.environ.get("WAHA_WEBHOOK_SECRET", "").strip()
    if not waha_secret:
        log_line("error", "🔒", "WAHA_HMAC", "WAHA webhook rejected: WAHA_WEBHOOK_SECRET is missing")
        raise HTTPException(status_code=503, detail=error_detail("webhook.waha_secret_not_configured"))
    sig_header = request.headers.get("x-webhook-hmac-sha256") or request.headers.get("x-hub-signature-256") or ""
    body_bytes = await request.body()
    expected = hmac.new(waha_secret.encode(), body_bytes, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(sig_header.replace("sha256=", ""), expected):
        log_line("error", "🔒", "WAHA_HMAC", "Invalid webhook signature")
        raise HTTPException(status_code=403, detail=error_detail("webhook.invalid_signature"))
    try:
        data = await request.json()
        payload = data.get("payload", {})
        if payload.get("fromMe"):
            return {"status": "ignored"}
        chat_id = payload.get("from")
        user_msg = (payload.get("body") or "").strip()
        has_media = payload.get("hasMedia") and payload.get("media")
        media = payload.get("media") or {}
        media_url = media.get("url")
        media_mimetype = (media.get("mimetype") or "").lower()

        # Debug: de ce ignorăm (poze fără caption sau media neîn descărcat)
        if not user_msg and not (has_media and media_url):
            event = data.get("event", "?")
            reason = f"event={event} – no text and no media URL"
            if payload.get("hasMedia") and not media_url:
                reason += " (hasMedia=True but media.url missing – check WAHA media storage)"
            log_line("sys", "📩", "WAHA IGNORED", reason)
            return {"status": "ignored"}

        image_base64 = None
        if has_media and media_url and media_mimetype.startswith("image/"):
            image_base64 = await _waha_download_media_as_base64(media_url, media_mimetype, cfg, request.app.state.http_client, log_line)
            if image_base64:
                log_line("user_head", "🖼", "WAHA IMAGE", f"Downloaded image ({len(image_base64)} b64 chars)")
            elif media_url:
                log_line("error", "🖼", "WAHA IMAGE", "Download failed or not image")
        if not user_msg and not image_base64:
            log_line("sys", "📩", "WAHA IGNORED", "image download failed or not image/*")
            return {"status": "ignored"}

        # Whitelist: config + numere legate de useri (DB)
        allowed = set(cfg.get("security", {}).get("allowed_numbers", []))
        for p in db.query(models.PhoneNumber).all():
            allowed.add(p.waha_id)
            allowed.add(p.number.replace(" ", "").strip() if p.number else "")
        if cfg.get("security", {}).get("whitelist_enabled") and allowed:
            if chat_id not in allowed and chat_id.split("@")[0] not in allowed:
                return {"status": "blocked"}

        # --- IDENTITY CHECK ---
        unified_user_id = chat_id
        phone_entry = db.query(models.PhoneNumber).filter(models.PhoneNumber.waha_id == chat_id).first()
        if phone_entry:
            unified_user_id = f"user_{phone_entry.user_id}"
            log_line("success", "🔗", "AUTH", f"Message linked to Account ID: {unified_user_id} ({phone_entry.owner.username})")

        log_conversation_start("whatsapp", unified_user_id, user_msg or "[image]", has_image=bool(image_base64))

        # Comandă /clear: șterge contextul conversației (istoric + context HA) și răspunde scurt
        if (user_msg or "").strip().lower() == "/clear":
            async with whatsapp_context_lock:
                whatsapp_context_store[chat_id] = []
            async with brain.CONTEXT_LOCK:
                brain.USER_CONTEXT.pop(unified_user_id, None)
            log_line("mem", "🗑️", "CONTEXT", f"Cleared for WhatsApp {chat_id}")
            prompts_cfg = cfg.get("prompts") or {}
            clear_reply = prompts_cfg.get("clear_context_message") or "Context cleared. Conversation starts from scratch."
            url = f"{cfg['waha']['api_url']}/api/sendText"
            headers = {"Content-Type": "application/json", "X-Api-Key": cfg['waha'].get('api_key', '')}
            auth = (cfg['waha']['username'], cfg['waha']['password']) if cfg['waha'].get('username') else None
            try:
                await request.app.state.http_client.post(url, json={"chatId": chat_id, "text": clear_reply, "session": "default"}, headers=headers, auth=auth, timeout=10)
            except Exception as e:
                log_line("error", "❌", "SEND FAIL", str(e))
            return {"status": "ok"}

        async with whatsapp_context_lock:
            history = list(whatsapp_context_store.get(chat_id, []))
        persona = phone_entry.owner.persona_override if phone_entry else None
        ai_text, _ = await brain.generate_response(user_msg or "", history, unified_user_id, persona_override=persona, conversation_summary=None, image_base64=image_base64)
        ai_text = brain.strip_think(ai_text or "")

        # Extrage imagini markdown ![alt](url) și trimite-le ca poze pe WhatsApp; textul rămas ca mesaj text
        image_urls = _extract_markdown_image_urls(ai_text, log_line)
        text_to_send = _strip_markdown_images(ai_text)

        url = f"{cfg['waha']['api_url']}/api/sendText"
        headers = {"Content-Type": "application/json", "X-Api-Key": cfg['waha'].get('api_key', '')}
        auth = (cfg['waha']['username'], cfg['waha']['password']) if cfg['waha'].get('username') else None

        _http = request.app.state.http_client
        # 1. Trimite textul (fără blocuri de imagine)
        if text_to_send:
            try:
                await _http.post(url, json={"chatId": chat_id, "text": text_to_send, "session": "default"}, headers=headers, auth=auth, timeout=15.0)
                log_line("user_head", "🚀", "DELIVERED", "Text sent.")
            except Exception as e:
                log_line("error", "❌", "SEND FAIL", str(e))
        # 2. Trimite fiecare imagine cu sendImage (WAHA Plus); la 422 trimitem linkurile ca text
        plus_required = False
        for _alt, img_url in image_urls:
            result = await _waha_send_image(chat_id, img_url, None, cfg, request.app.state.http_client, log_line)
            if result == "plus_required":
                plus_required = True
                break
        if plus_required and image_urls:
            links_msg = "Imagini (deschide linkurile):\n" + "\n".join(url for _, url in image_urls)
            try:
                await _http.post(url, json={"chatId": chat_id, "text": links_msg, "session": "default"}, headers=headers, auth=auth, timeout=15.0)
            except Exception as e:
                log_line("error", "❌", "SEND FAIL", str(e))
            if image_urls and not text_to_send and not plus_required:
                log_line("user_head", "🚀", "DELIVERED", f"Image(s) sent ({len(image_urls)}).")
            elif image_urls:
                log_line("user_head", "🚀", "DELIVERED", f"Text + {len(image_urls)} image(s) sent." if not plus_required else "Text + image links sent (Plus required for inline images).")

        user_content_for_history = user_msg if user_msg else ("[Imagine]" if image_base64 else "")
        clean_ai_text = brain.strip_think(ai_text)
        history.append({"role": "user", "content": user_content_for_history})
        history.append({"role": "assistant", "content": clean_ai_text})
        async with whatsapp_context_lock:
            whatsapp_context_store[chat_id] = history[-10:]
        log_conversation_reply(ai_text, profile_name=settings.get_active_profile_name())
        try:
            from task_utils import create_tracked_task
            create_tracked_task(brain.process_memory_pipeline(user_msg or user_content_for_history, unified_user_id, clean_ai_text, history), name="memory_pipeline_wa")
        except Exception:
            # Fallback: schedule via background tasks if create_task fails
            try:
                background_tasks.add_task(brain.process_memory_pipeline, user_msg or user_content_for_history, unified_user_id, clean_ai_text, history)
            except Exception:
                log_line("error", "⚠️", "MEMORY", "Failed to schedule memory pipeline")
        return {"status": "ok"}
    except Exception as e:
        log_line("error", "⚠️", "EXCEPTION", traceback.format_exc())
        return JSONResponse(status_code=500, content={"error": "internal_server_error"})
