from __future__ import annotations

import json
import time

from core import i18n as core_i18n
from logger import log_detail, log_line

from brain.ambient import actions, config, llm, runtime, triggers

from brain.ambient.actions import _allowed_ambient_tools, _ambient_action_specs, _ambient_context_tags, _ambient_dismiss_issues, _ambient_sync_slugs, _execute_actions, _normalize_ambient_tool, _sanitize_decision_actions, ambient_actions_for_context, format_ambient_actions_catalog
from brain.ambient.config import _cfg, _entity_source, _ignore_unavailable_entities, _ignored_sources, _mode, _should_skip_entity, is_enabled
from brain.ambient.llm import _aux_gate, _extract_json, _get_ui_language, _llm_complete, _llm_endpoint, _normalize_chat_url, _reason, _resolve_profile, default_reasoner_prompt, reasoner_system_prompt
from brain.ambient.runtime import _load_state, _save_state
from brain.ambient.triggers import _enqueue, _on_state_event

async def act_on_suggestion(user_id: int, notification_id: str, action_index: int) -> dict:
    """Execute one suggested action from an ambient notification, then record
    the acceptance for pattern learning."""
    import database
    import models
    from core import notification_service

    db = database.SessionLocal()
    try:
        row = (
            db.query(models.Notification)
            .filter(models.Notification.id == notification_id, models.Notification.user_id == user_id)
            .first()
        )
        if row is None:
            return {"ok": False, "error": "not_found"}
        try:
            payload = json.loads(row.payload_json or "{}")
        except Exception:
            payload = {}
        actions = payload.get("suggested_actions") or []
        match = next((a for a in actions if int(a.get("index", -1)) == int(action_index)), None)
        if not match:
            return {"ok": False, "error": "action_not_found"}
        pattern_key = str(payload.get("pattern_key") or "")
        issue_keys = payload.get("issue_keys") if isinstance(payload.get("issue_keys"), list) else []
    finally:
        db.close()

    tool = _normalize_ambient_tool(str(match.get("tool") or ""), str(match.get("label") or ""))
    action_args = dict(match.get("args") or {})
    if tool == "ambient_dismiss" and issue_keys and "issue_keys" not in action_args:
        action_args["issue_keys"] = issue_keys
    if tool == "sync_integration" and not action_args.get("slugs") and not action_args.get("slug") and issue_keys:
        slugs = sorted({str(k).split(":", 1)[1] for k in issue_keys if ":" in str(k)})
        if slugs:
            action_args["slugs"] = slugs

    # navigate is a frontend-only tool — mark as success without calling toolbox
    if tool == "navigate":
        results = [{"tool": "navigate", "args": action_args, "ok": True, "result": "navigated"}]
    else:
        results = await _execute_actions([{"tool": tool, "label": match.get("label"), "args": action_args}], user_id)
    ok = bool(results and results[0].get("ok"))
    navigate_url = ""
    if tool == "navigate":
        navigate_url = str(action_args.get("url") or "").strip()

    # Mark the notification handled.
    db = database.SessionLocal()
    try:
        notification_service.mark_read(db, user_id, notification_id)
        if ok:
            notification_service.archive_notification(db, user_id, notification_id)
    except Exception:
        pass
    finally:
        db.close()

    if ok and pattern_key:
        _record_acceptance(pattern_key, {**match, "tool": tool, "args": action_args}, user_id)

    return {"ok": ok, "results": results, "navigate_url": navigate_url,
            "message": (results[0].get("result") if ok and results else None) or (results[0].get("error") if results else None),
            "error": None if ok else (results[0].get("error") if results else "failed")}

def _record_acceptance(pattern_key: str, action: dict, user_id: int) -> None:
    if not _cfg().get("learn_patterns", True):
        return
    entry = runtime._pattern_counts.get(pattern_key) or {"count": 0, "example": None, "proposed": False}
    entry["count"] = int(entry.get("count", 0)) + 1
    entry["example"] = {"tool": action.get("tool"), "args": action.get("args")}
    runtime._pattern_counts[pattern_key] = entry
    _save_state()

    threshold = int(_cfg().get("learn_threshold", 3) or 3)
    if entry["count"] >= threshold and not entry.get("proposed"):
        entry["proposed"] = True
        _save_state()
        _enqueue({"type": "propose_automation", "pattern_key": pattern_key, "user_id": user_id})

async def _propose_automation(pattern_key: str, user_id: int) -> None:
    """F4: after repeated acceptance, ask the reasoner for an automation YAML and
    offer to create it with one click."""
    entry = runtime._pattern_counts.get(pattern_key) or {}
    example = entry.get("example") or {}
    sys = core_i18n.t("brain.ambient.automation_learner_system")
    usr = (
        f"Situation key: {pattern_key}\n"
        f"Action repeatedly approved: {json.dumps(example, ensure_ascii=False)}\n"
        f"The user approved this {entry.get('count')} times. Propose an automation."
    )
    out = await _llm_complete(
        [{"role": "system", "content": sys}, {"role": "user", "content": usr}],
        prefer_aux=False, max_tokens=500, temperature=0.2, timeout=45.0,
    )
    proposal = _extract_json(out)
    if not isinstance(proposal, dict) or not proposal.get("source_yaml"):
        return
    from core import notification_service
    notification_service.create_and_dispatch(
        user_id=user_id,
        title=str(proposal.get("title") or core_i18n.t("brain.ambient.automation_proposal.title")).strip()[:120],
        body=str(proposal.get("body") or core_i18n.t("brain.ambient.automation_proposal.body")).strip(),
        category="ambient",
        severity="info",
        dedupe_key=f"ambient:automate:{pattern_key}",
        payload={
            "ambient": True,
            "kind": "automation_proposal",
            "pattern_key": pattern_key,
            "suggested_actions": [{
                "index": 0,
                "label": core_i18n.t("brain.ambient.automation_proposal.create_label"),
                "tool": "create_automation_definition",
                "args": {"source_yaml": proposal.get("source_yaml")},
            }],
        },
    )
    log_line("ambient", "⚙️", "LEARN", f"proposed automation for pattern '{pattern_key}'")

