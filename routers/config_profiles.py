from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

import core.auth as auth
import core.database as database
import core.models as models
import core.scheduler_service as scheduler_service
import core.settings as settings
from core.auto_router_stats import get_auto_router_stats
from core.http.errors import error_detail

router = APIRouter()


def _is_masked_secret(value: str | None) -> bool:
    """Return True for UI placeholders like bullets/asterisks used for redacted secrets."""
    if not isinstance(value, str):
        return False
    s = value.strip()
    if not s:
        return False
    return bool(s) and all(ch in "•*●·xX#-" for ch in s)


def _merge_masked_secrets(incoming: dict, existing: dict):
    """Replace redacted placeholders in incoming config with the current stored secret values."""
    if not isinstance(incoming, dict) or not isinstance(existing, dict):
        return
    for key, value in list(incoming.items()):
        current = existing.get(key)
        if isinstance(value, dict) and isinstance(current, dict):
            _merge_masked_secrets(value, current)
        elif isinstance(value, str) and _is_masked_secret(value) and isinstance(current, str):
            incoming[key] = current


@router.get("/api/config")
async def get_cfg(current_user: models.User = Depends(auth.get_current_user)):
    cfg = settings.reload_config()
    import copy
    safe = copy.deepcopy(cfg)
    # Redact secrets for all users (including admins) — secrets should come from env vars
    _SECRET_KEYS = ("api_key", "token", "password", "secret", "service_account_path")
    def _redact(d: dict, keys=_SECRET_KEYS):
        for k, v in list(d.items()):
            if isinstance(v, dict):
                _redact(v, keys)
            elif any(sk in k.lower() for sk in keys) and isinstance(v, str) and v:
                d[k] = "••••••"
    if not current_user.is_admin:
        for section_key in ('llm', 'coder', 'vision_llm'):
            section = safe.get(section_key)
            if isinstance(section, dict):
                section.pop('api_key', None)
        safe.pop('home_assistant', None)
        waha = safe.get('waha')
        if isinstance(waha, dict):
            waha.pop('api_key', None)
        fcm = safe.get('fcm')
        if isinstance(fcm, dict):
            fcm.pop('service_account_path', None)
        intel = safe.get('intelligence', {})
        aux = intel.get('aux_llm') if isinstance(intel, dict) else None
        if isinstance(aux, dict):
            aux.pop('api_key', None)
    else:
        _redact(safe)

    mem = safe.get("memory")
    if isinstance(mem, dict) and not mem.get("extraction_rules"):
        try:
            from brain.cortex import _MEMORY_RULES
            mem["extraction_rules"] = _MEMORY_RULES.strip()
        except Exception:
            pass

    prompts = safe.get("prompts")
    if isinstance(prompts, dict):
        from core.settings import DEFAULT_CONFIG as DEFAULTS
        defaults_p = DEFAULTS.get("prompts", {})
        for key in ("system_persona", "agent_instructions", "agent_instructions_fallback",
                     "agent_instruction_overrides", "search_web_single_message_instruction",
                     "web_content_reply_instruction", "image_placeholder", "summarize"):
            if not prompts.get(key):
                prompts[key] = defaults_p.get(key, "")

    return safe


@router.post("/api/config")
async def set_cfg(data: dict, _: models.User = Depends(auth.get_current_admin)):
    existing = settings.reload_config()
    _merge_masked_secrets(data, existing)
    settings.save_config(data)
    settings.reload_config()
    try:
        from brain.cortex.prompt_cache import invalidate_prompt_cache
        invalidate_prompt_cache()
    except Exception:
        pass
    try:
        scheduler_service.schedule_consolidation_job()
    except Exception:
        pass
    try:
        from routers.updates import schedule_all_update_checks
        from core.backup.schedule import schedule_backup_job

        schedule_all_update_checks()
        schedule_backup_job()
    except Exception:
        pass
    return {"status": "ok"}


@router.patch("/api/config")
async def patch_cfg(data: dict, current_user: models.User = Depends(auth.get_current_user)):
    allowed = None if current_user.is_admin else ["ui"]
    existing = settings.reload_config()
    _merge_masked_secrets(data, existing)
    settings.merge_config_partial(data, allowed_top_level_keys=allowed)
    settings.reload_config()
    try:
        from brain.cortex.prompt_cache import invalidate_prompt_cache
        invalidate_prompt_cache()
    except Exception:
        pass
    return {"status": "ok"}


@router.get("/api/model-profiles")
async def list_model_profiles(current_user: models.User = Depends(auth.get_current_user)):
    profiles = list(settings.CFG.get("model_profiles") or [])
    for p in profiles:
        if "visible_in_selector" not in p:
            p["visible_in_selector"] = True
    active_id = settings.CFG.get("active_profile_id") or ""
    default_profile_id = getattr(current_user, "default_profile_id", None) or ""

    if not current_user.is_admin:
        for p in profiles:
            if p.get("api_key"):
                p["api_key"] = "••••••"
            aux = p.get("aux_llm") or {}
            if aux.get("api_key"):
                aux["api_key"] = "••••••"
            coder_p = p.get("coder") or {}
            if coder_p.get("api_key"):
                coder_p["api_key"] = "••••••"
            vision_p = p.get("vision_llm") or {}
            if vision_p.get("api_key"):
                vision_p["api_key"] = "••••••"

    llm = settings.CFG.get("llm") or {}
    active_model = llm.get("model_name") or ""
    active_provider = llm.get("source") or llm.get("provider") or "local"

    return {
        "profiles": profiles,
        "active_id": active_id,
        "default_profile_id": default_profile_id,
        "active_model": active_model,
        "active_provider": active_provider,
        **({"auto_router_stats": get_auto_router_stats()} if current_user.is_admin else {}),
    }


@router.post("/api/model-profiles")
async def save_model_profile(data: dict, current_user: models.User = Depends(auth.get_current_user)):
    if not current_user.is_admin:
        raise HTTPException(status_code=403, detail=error_detail("common.admin_required"))
    import uuid as _uuid
    profile_id = (data.get("id") or "").strip() or str(_uuid.uuid4())[:8]
    profile = {
        "id": profile_id,
        "name": (data.get("name") or "").strip() or "Unnamed",
        "provider": (data.get("provider") or "local").strip(),
        "target_url": (data.get("target_url") or "").strip(),
        "model_name": (data.get("model_name") or "").strip(),
        "api_key": (data.get("api_key") or "").strip(),
        "temperature": float(data.get("temperature") or 0.7),
        "timeout": int(data.get("timeout") or 120),
        "context_length": int(data.get("context_length") or 24000),
        "max_tokens": int(data.get("max_tokens") or 2048),
        "aux_llm_enabled": bool(data.get("aux_llm_enabled", False)),
        "aux_llm": {
            "target_url": (data.get("aux_llm", {}).get("target_url") or "").strip(),
            "model_name": (data.get("aux_llm", {}).get("model_name") or "").strip(),
            "api_key": (data.get("aux_llm", {}).get("api_key") or "").strip(),
        },
        "coder_enabled": bool(data.get("coder_enabled", False)),
        "coder": {
            "provider": (data.get("coder", {}).get("provider") or "local").strip(),
            "target_url": (data.get("coder", {}).get("target_url") or "").strip(),
            "model_name": (data.get("coder", {}).get("model_name") or "").strip(),
            "api_key": (data.get("coder", {}).get("api_key") or "").strip(),
            "timeout": int(data.get("coder", {}).get("timeout") or 180),
        },
        "vision_enabled": bool(data.get("vision_enabled", False)),
        "vision_llm": {
            "provider": (data.get("vision_llm", {}).get("provider") or "local").strip(),
            "target_url": (data.get("vision_llm", {}).get("target_url") or "").strip(),
            "model_name": (data.get("vision_llm", {}).get("model_name") or "").strip(),
            "api_key": (data.get("vision_llm", {}).get("api_key") or "").strip(),
            "timeout": int(data.get("vision_llm", {}).get("timeout") or 60),
            "respond_directly": bool(data.get("vision_llm", {}).get("respond_directly", False)),
        },
        "embed_enabled": bool(data.get("embed_enabled", False)),
        "librarian": {
            "model_name": (data.get("librarian", {}).get("model_name") or "").strip(),
        },
        "color": (data.get("color") or "#6366f1").strip(),
        "visible_in_selector": bool(data.get("visible_in_selector", True)),
        "persona_override": (data.get("persona_override") or "").strip() or None,
        "capability_reasoning": bool(data.get("capability_reasoning", True)),
        "capability_tool_calling": bool(data.get("capability_tool_calling", True)),
        "capability_vision": bool(data.get("capability_vision", True)),
    }
    if profile["vision_enabled"] and (
        (profile["vision_llm"].get("target_url") or "").strip()
        or (profile["vision_llm"].get("model_name") or "").strip()
    ):
        profile["capability_vision"] = True

    profiles = list(settings.CFG.get("model_profiles") or [])
    existing = next((p for p in profiles if p["id"] == profile_id), None)
    if existing:
        if profile["api_key"] == "••••••":
            profile["api_key"] = existing.get("api_key") or ""
        if profile["aux_llm"]["api_key"] == "••••••":
            profile["aux_llm"]["api_key"] = (existing.get("aux_llm") or {}).get("api_key") or ""
        if profile["coder"]["api_key"] == "••••••":
            profile["coder"]["api_key"] = (existing.get("coder") or {}).get("api_key") or ""
        if profile["vision_llm"]["api_key"] == "••••••":
            profile["vision_llm"]["api_key"] = (existing.get("vision_llm") or {}).get("api_key") or ""
        if "visible_in_selector" not in data and "visible_in_selector" in existing:
            profile["visible_in_selector"] = existing.get("visible_in_selector", True)
        if "persona_override" not in data and "persona_override" in existing:
            profile["persona_override"] = existing.get("persona_override")
        for key in ("capability_reasoning", "capability_tool_calling", "capability_vision"):
            if key not in data and key in existing:
                profile[key] = existing.get(key, True)
        idx = profiles.index(existing)
        profiles[idx] = profile
    else:
        profiles.append(profile)

    settings.save_config({"model_profiles": profiles})
    settings.reload_config()
    return {"status": "ok", "profile": profile}


@router.delete("/api/model-profiles/{profile_id}")
async def delete_model_profile(profile_id: str, current_user: models.User = Depends(auth.get_current_user)):
    if not current_user.is_admin:
        raise HTTPException(status_code=403, detail=error_detail("common.admin_required"))
    profiles = [p for p in (settings.CFG.get("model_profiles") or []) if p.get("id") != profile_id]
    update = {"model_profiles": profiles}
    if settings.CFG.get("active_profile_id") == profile_id:
        update["active_profile_id"] = ""
    settings.save_config(update)
    settings.reload_config()
    return {"status": "ok"}


@router.patch("/api/model-profiles/{profile_id}")
async def patch_model_profile(profile_id: str, body: dict, current_user: models.User = Depends(auth.get_current_user)):
    if not current_user.is_admin:
        raise HTTPException(status_code=403, detail=error_detail("common.admin_required"))
    if "visible_in_selector" not in body:
        return {"status": "ok"}
    profiles = list(settings.CFG.get("model_profiles") or [])
    for p in profiles:
        if p.get("id") == profile_id:
            p["visible_in_selector"] = bool(body["visible_in_selector"])
            break
    else:
        raise HTTPException(status_code=404, detail=error_detail("config.profile_not_found"))
    settings.save_config({"model_profiles": profiles})
    settings.reload_config()
    return {"status": "ok"}


@router.post("/api/model-profiles/reorder")
async def reorder_model_profiles(body: dict, current_user: models.User = Depends(auth.get_current_user)):
    if not current_user.is_admin:
        raise HTTPException(status_code=403, detail=error_detail("common.admin_required"))
    order = body.get("order")
    if not isinstance(order, list) or not order:
        raise HTTPException(status_code=400, detail=error_detail("config.profile_order_invalid"))
    profiles = list(settings.CFG.get("model_profiles") or [])
    by_id = {p.get("id"): p for p in profiles if p.get("id")}
    ordered = []
    for pid in order:
        if pid in by_id:
            ordered.append(by_id.pop(pid))
    for p in by_id.values():
        ordered.append(p)
    settings.save_config({"model_profiles": ordered})
    settings.reload_config()
    return {"status": "ok"}


@router.post("/api/model-profiles/{profile_id}/activate")
async def activate_model_profile(profile_id: str, current_user: models.User = Depends(auth.get_current_user), db: Session = Depends(database.get_db)):
    if (profile_id or "").strip().lower() == "auto":
        current_user.default_profile_id = "auto"
        db.commit()
        return {"status": "ok"}
    profiles = settings.CFG.get("model_profiles") or []
    profile = next((p for p in profiles if p.get("id") == profile_id), None)
    if not profile:
        raise HTTPException(status_code=404, detail=error_detail("config.profile_not_found"))

    current_user.default_profile_id = profile_id
    db.commit()

    if current_user.is_admin:
        llm_update = {
            "target_url": profile.get("target_url") or "",
            "model_name": profile.get("model_name") or "",
            "api_key": profile.get("api_key") or "",
            "source": profile.get("provider") or "local",
            "temperature": profile.get("temperature", 0.7),
            "timeout": profile.get("timeout", 120),
            "context_length": profile.get("context_length", 24000),
            "max_tokens": profile.get("max_tokens", 2048),
        }
        update = {"llm": llm_update, "active_profile_id": profile_id}
        # Always sync intelligence.aux_llm with the active profile. When the
        # profile has aux disabled, blank it out so consumers (intent_router,
        # direct_commands, scheduler, cortex._get_aux_or_main_llm) fall back
        # to the main LLM instead of using a stale aux_llm from a previous
        # profile.
        intel = dict(settings.CFG.get("intelligence") or {})
        if profile.get("aux_llm_enabled"):
            aux = profile.get("aux_llm") or {}
            intel["aux_llm"] = {
                "target_url": aux.get("target_url") or "",
                "model_name": aux.get("model_name") or "",
                "api_key": aux.get("api_key") or "",
            }
        else:
            intel["aux_llm"] = {"target_url": "", "model_name": "", "api_key": ""}
        update["intelligence"] = intel
        if profile.get("coder_enabled"):
            coder = profile.get("coder") or {}
            update["coder"] = {
                "target_url": coder.get("target_url") or "",
                "model_name": coder.get("model_name") or "",
                "api_key": coder.get("api_key") or "",
                "source": coder.get("provider") or "local",
                "timeout": coder.get("timeout", 180),
            }
        if profile.get("vision_enabled"):
            vision = profile.get("vision_llm") or {}
            update["vision_llm"] = {
                "target_url": vision.get("target_url") or "",
                "model_name": vision.get("model_name") or "",
                "api_key": vision.get("api_key") or "",
                "source": vision.get("provider") or "local",
                "timeout": vision.get("timeout", 60),
                "respond_directly": vision.get("respond_directly", False),
            }
        if profile.get("embed_enabled"):
            lib = profile.get("librarian") or {}
            existing_librarian = dict(settings.CFG.get("librarian") or {})
            existing_librarian["model_name"] = lib.get("model_name") or ""
            update["librarian"] = existing_librarian
        settings.save_config(update)
        settings.reload_config()
        try:
            from brain.cortex.prompt_cache import invalidate_prompt_cache
            invalidate_prompt_cache()
        except Exception:
            pass
    return {"status": "ok", "active_model": profile.get("model_name") or ""}
