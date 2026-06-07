from __future__ import annotations

from typing import Optional

from core import i18n as core_i18n
from logger import log_detail, log_line

from brain.ambient import actions, config, context, constants, entities, issues, llm, rate_limit

from brain.ambient.actions import _allowed_ambient_tools, _ambient_action_specs, _ambient_context_tags, _ambient_dismiss_issues, _ambient_sync_slugs, _execute_actions, _normalize_ambient_tool, _sanitize_decision_actions, ambient_actions_for_context, format_ambient_actions_catalog
from brain.ambient.config import _cfg, _entity_source, _ignore_unavailable_entities, _ignored_sources, _mode, _should_skip_entity, is_enabled
from brain.ambient.context import _build_context
from brain.ambient.issues import _attach_issue_awareness, _current_proactive_issues, _mark_issues_notified, _new_issue_keys, _reconcile_notified_issues, _unavailable_clusters
from brain.ambient.llm import _aux_gate, _extract_json, _get_ui_language, _llm_complete, _llm_endpoint, _normalize_chat_url, _reason, _resolve_profile, default_reasoner_prompt, reasoner_system_prompt
from brain.ambient.rate_limit import _dedupe_ok, _dedupe_ttl_s, _in_quiet_hours, _mark_thought, _mentions_health_topic, _navigates_to_integrations, _parse_hhmm, _rate_ok, _stable_dedupe_key

def _primary_admin() -> Optional[int]:
    import database
    import models
    db = database.SessionLocal()
    try:
        user = (
            db.query(models.User)
            .filter(models.User.is_admin == True, models.User.is_active == True)  # noqa: E712
            .order_by(models.User.id.asc())
            .first()
        )
        return int(user.id) if user else None
    finally:
        db.close()

async def run_ambient_cycle(batch: list[dict]) -> None:
    if not is_enabled():
        return
    mode = _mode()

    if _in_quiet_hours():
        log_detail("ambient", "SKIP", reason="quiet_hours")
        return
    ok, why = _rate_ok()
    if not ok:
        log_detail("ambient", "SKIP", reason=why)
        return

    context = _build_context(batch)
    new_issue_keys = set(context.get("new_proactive_issue_keys") or [])

    if context["trigger"] == "event" and not context["events"] and not new_issue_keys:
        return
    # Periodic scan/check-in: skip when user was already told and nothing else is urgent.
    if context["trigger"] in {"scan", "checkin"} and not new_issue_keys and not context.get("long_running"):
        log_detail("ambient", "SKIP", reason="already_aware", new_issues=0)
        return

    if not await _aux_gate(context):
        log_detail("ambient", "GATE", result="no")
        return

    decision = await _reason(context)
    if decision is not None:
        decision["_notify_issue_keys"] = sorted(new_issue_keys)
        decision["actions"] = _sanitize_decision_actions(decision, context)
    await _dispatch_decision(decision, mode=mode)

async def _dispatch_decision(decision: Optional[dict], *, mode: str, force: bool = False) -> dict:
    """Turn a reasoner decision into a notification / autonomous action.
    Returns a summary dict (used by the manual test entrypoint)."""
    if not decision or not decision.get("act"):
        log_detail("ambient", "DECISION", act=False)
        return {"acted": False, "decision": decision or {}}

    title = str(decision.get("title") or "HYVE").strip()[:120]
    body = str(decision.get("body") or "").strip()
    actions = decision.get("actions") if isinstance(decision.get("actions"), list) else []
    notify_keys = set(decision.get("_notify_issue_keys") or [])
    if not force and _mentions_health_topic(decision) and not notify_keys:
        log_detail("ambient", "SKIP", reason="repeat_health", title=title[:60])
        return {"acted": False, "reason": "repeat_health", "decision": decision}

    pattern_key = str(decision.get("pattern_key") or "").strip()
    dedupe = f"ambient:test:{pattern_key or title}" if force else _stable_dedupe_key(decision, notify_keys or None)

    if not force and not _dedupe_ok(dedupe):
        log_detail("ambient", "SKIP", reason="dedupe", key=dedupe)
        return {"acted": False, "reason": "dedupe", "decision": decision}

    # F0: observe-only — log what we WOULD do, no side effects (tests still emit).
    if mode == "observe" and not force:
        log_line("ambient", "👁️", "OBSERVE", f"would suggest: {title} | {body[:80]} | actions={len(actions)}")
        _mark_thought()
        return {"acted": False, "reason": "observe", "decision": decision}

    user_id = _primary_admin()
    if user_id is None:
        log_detail("ambient", "SKIP", reason="no_admin_user")
        return {"acted": False, "reason": "no_admin_user", "decision": decision}

    # F3: autonomous execution when allowed + whitelisted (never during a test).
    allowed = set(_cfg().get("allowed_autonomous_actions") or [])
    want_auto = (not force) and mode == "autonomous" and bool(decision.get("autonomous")) and actions
    can_auto = want_auto and all((a.get("tool") in allowed) for a in actions)

    if want_auto and can_auto:
        results = await _execute_actions(actions, user_id)
        _mark_thought()
        done_body = body or title
        from core import notification_service
        notification_service.create_and_dispatch(
            user_id=user_id,
            title=title,
            body=f"{done_body}\n\n✅ Am rezolvat automat.",
            category="ambient",
            severity="info",
            dedupe_key=dedupe,
            payload={
                "ambient": True,
                "kind": "autonomous_done",
                "pattern_key": pattern_key,
                "reason": decision.get("reason"),
                "executed": results,
            },
        )
        if not force and notify_keys:
            _mark_issues_notified(notify_keys, title=title)
        log_line("ambient", "🤖", "AUTO", f"{title} → executed {len(results)} action(s)")
        return {"acted": True, "kind": "autonomous_done", "decision": decision}

    # F1/F2: suggest (actionable notification, human-in-the-loop).
    suggested = []
    for a in actions:
        if not isinstance(a, dict) or not a.get("tool"):
            continue
        suggested.append({
            "index": len(suggested),
            "label": str(a.get("label") or core_i18n.t("brain.ambient.action_apply_label")).strip()[:60],
            "tool": str(a.get("tool")),
            "args": a.get("args") if isinstance(a.get("args"), dict) else {},
        })

    if not force:
        _mark_thought()
    # If actions include navigate, set action_url for the notification card
    nav_url = None
    for a in suggested:
        if a.get("tool") == "navigate" and isinstance(a.get("args"), dict):
            nav_url = a["args"].get("url")
            break
    from core import notification_service
    notification_service.create_and_dispatch(
        user_id=user_id,
        title=(f"[TEST] {title}" if force else title)[:120],
        body=body or title,
        category="ambient",
        severity="info",
        dedupe_key=dedupe,
        action_url=nav_url,
        payload={
            "ambient": True,
            "kind": "suggestion",
            "pattern_key": pattern_key,
            "reason": decision.get("reason"),
            "issue_keys": sorted(notify_keys),
            "suggested_actions": suggested,
        },
    )
    if not force and notify_keys:
        _mark_issues_notified(notify_keys, title=title)
    log_line("ambient", "💡", "SUGGEST", f"{'[TEST] ' if force else ''}{title} ({len(suggested)} action(s))")
    return {"acted": True, "kind": "suggestion", "actions": len(suggested), "decision": decision}

async def run_test() -> dict:
    """Manual trigger from settings: reason over the CURRENT home (treating any
    on/open device as a candidate, ignoring duration) and emit a [TEST] result,
    bypassing quiet hours / rate limits. Never runs autonomous actions."""
    if not is_enabled():
        return {"ok": False, "error": "disabled"}
    url, model, _ = _llm_endpoint(prefer_aux=False)
    if not url or not model:
        return {"ok": False, "error": "no_llm"}
    context = _build_context([{"type": "scan"}])
    context["trigger"] = "test"
    context["long_running"] = [
        r for r in context["home"] if str(r.get("state") or "").lower() in constants._ON_STATES
    ]
    decision = await _reason(context)
    if decision is not None:
        decision["actions"] = _sanitize_decision_actions(decision, context)
    summary = await _dispatch_decision(decision, mode=_mode(), force=True)
    return {
        "ok": True,
        "candidates": len(context["long_running"]),
        "acted": summary.get("acted", False),
        "title": (decision or {}).get("title"),
        "body": (decision or {}).get("body"),
    }

