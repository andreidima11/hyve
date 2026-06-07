from __future__ import annotations

import json
from typing import Any

from core import i18n as core_i18n
from logger import log_detail

from brain.ambient import config, issues

from brain.ambient.issues import _attach_issue_awareness, _current_proactive_issues, _mark_issues_notified, _new_issue_keys, _reconcile_notified_issues, _unavailable_clusters

def _ambient_action_specs() -> list[dict[str, Any]]:
    raw = core_i18n.get("brain.ambient.action_specs")
    if not isinstance(raw, list):
        return []
    specs: list[dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        spec = dict(item)
        spec["tags"] = set(spec.get("tags") or [])
        specs.append(spec)
    return specs

def _ambient_context_tags(context: dict[str, Any]) -> set[str]:
    tags: set[str] = set()
    if context.get("long_running"):
        tags.add("long_running")
    if context.get("events"):
        tags.add("events")
    if context.get("weather"):
        tags.add("weather")
    if context.get("upcoming_events"):
        tags.add("calendar")
    if context.get("home"):
        tags.add("devices")
    for issue in context.get("new_proactive_issues") or []:
        kind = str(issue.get("kind") or "").strip().lower()
        if kind == "sync":
            tags.add("sync_issues")
        elif kind == "unavailable":
            tags.add("unavailable")
    return tags

def ambient_actions_for_context(context: dict[str, Any]) -> list[dict[str, Any]]:
    """Return action specs relevant to this reasoning cycle."""
    tags = _ambient_context_tags(context)
    if not tags:
        tags = {"devices"}
    out: list[dict[str, Any]] = []
    for spec in _ambient_action_specs():
        spec_tags = set(spec.get("tags") or set())
        if spec_tags & tags:
            out.append(spec)
    # Always offer dismiss when there is something to act on.
    if tags & {"sync_issues", "unavailable", "long_running"}:
        dismiss = next((s for s in _ambient_action_specs() if s["tool"] == "ambient_dismiss"), None)
        if dismiss and dismiss not in out:
            out.append(dismiss)
    return out

def format_ambient_actions_catalog(context: dict[str, Any]) -> str:
    compact = []
    for spec in ambient_actions_for_context(context):
        compact.append({
            "tool": spec["tool"],
            "description": spec["description"],
            "when": spec.get("when"),
            "args": spec.get("args"),
            "label_hint": spec.get("label_hint"),
        })
    return json.dumps(compact, ensure_ascii=False, indent=2)

def _allowed_ambient_tools(context: dict[str, Any]) -> set[str]:
    return {str(s["tool"]) for s in ambient_actions_for_context(context)}

def _sanitize_decision_actions(decision: dict[str, Any], context: dict[str, Any]) -> list[dict[str, Any]]:
    allowed = _allowed_ambient_tools(context)
    clean: list[dict[str, Any]] = []
    for a in decision.get("actions") or []:
        if not isinstance(a, dict):
            continue
        tool = str(a.get("tool") or "").strip()
        if tool not in allowed:
            log_detail("ambient", "DROP_ACTION", tool=tool, allowed=sorted(allowed))
            continue
        clean.append(a)
    return clean

def _normalize_ambient_tool(tool: str, label: str) -> str:
    """Map LLM-invented tool names / localized button labels to supported ambient actions."""
    t = (tool or "").strip().lower()
    lbl = (label or "").strip().lower()
    if t in {"sync_integration", "sync_integrations", "restart_services", "restart_integrations", "resync_integrations"}:
        return "sync_integration"
    if t in {"ambient_dismiss", "ignore_for_now", "dismiss_issues", "snooze_issues"}:
        return "ambient_dismiss"
    if "reporn" in lbl or "restart" in lbl or "resync" in lbl or "sincroniz" in lbl or "resincroniz" in lbl:
        return "sync_integration"
    if ("ignor" in lbl and "acum" in lbl) or "ignore for now" in lbl or "snooze" in lbl:
        return "ambient_dismiss"
    return tool

async def _ambient_sync_slugs(slugs: list[str]) -> str:
    from integrations import get_integration_manager
    from addons.entity_store import get_entity_store

    store = get_entity_store()
    manager = get_integration_manager()
    if not slugs:
        issues, _ = _current_proactive_issues()
        slugs = sorted({str(i.get("source") or "").strip().lower() for i in issues if i.get("source")})
    if not slugs:
        return core_i18n.t("brain.ambient.sync.no_integrations")

    done: list[str] = []
    errors: list[str] = []
    for raw in slugs:
        slug = str(raw or "").strip().lower()
        if not slug:
            continue
        instances = manager.entries_for(slug)
        keys: list[str] = []
        if instances:
            keys = [inst.store_key for inst in instances if inst.supports_sync]
        elif store.get_fetcher(slug):
            keys = [slug]
        else:
            errors.append(core_i18n.t("brain.ambient.sync.unknown_integration", slug=slug))
            continue
        for key in keys:
            try:
                inst = manager.get_by_entry(key.split(":", 1)[1]) if ":" in key else manager.get(slug)
                if inst and not store.get_fetcher(key):
                    import settings as s
                    store.register_fetcher(
                        key,
                        inst.fetch_entities,
                        inst.format_context,
                        description=getattr(inst, "description", "") or "",
                    )
                    store.init_schedule(key, inst.sync_interval(s.CFG))
                await store.do_sync(key)
                done.append(key)
            except Exception as exc:
                errors.append(f"{key}: {exc}")
    try:
        from core.entity_catalog import invalidate_entity_cache
        invalidate_entity_cache()
    except Exception:
        pass
    if done and not errors:
        return core_i18n.t("brain.ambient.sync.resynced", done=", ".join(done))
    if done:
        return core_i18n.t("brain.ambient.sync.partial_success", done=", ".join(done), errors="; ".join(errors[:3]))
    raise RuntimeError("; ".join(errors[:3]) or core_i18n.t("brain.ambient.sync.failed"))

async def _ambient_dismiss_issues(issue_keys: list[str] | None = None) -> str:
    keys = {str(k).strip() for k in (issue_keys or []) if str(k).strip()}
    if not keys:
        _, current = _current_proactive_issues()
        keys = set(current)
    if keys:
        _mark_issues_notified(keys, title="Dismissed by user")
    return core_i18n.t("brain.ambient.dismiss.message")

async def _execute_actions(actions: list[dict], user_id: int) -> list[dict]:
    from brain import toolbox
    results = []
    for a in actions:
        if not isinstance(a, dict) or not a.get("tool"):
            continue
        tool = str(a.get("tool"))
        label = str(a.get("label") or "")
        args = a.get("args") if isinstance(a.get("args"), dict) else {}
        tool = _normalize_ambient_tool(tool, label)
        try:
            if tool == "sync_integration":
                slugs = args.get("slugs") if isinstance(args.get("slugs"), list) else []
                if args.get("slug"):
                    slugs = list(slugs) + [args["slug"]]
                out = await _ambient_sync_slugs([str(s) for s in slugs])
                results.append({"tool": tool, "args": args, "ok": True, "result": out[:300]})
                continue
            if tool == "ambient_dismiss":
                keys = args.get("issue_keys") if isinstance(args.get("issue_keys"), list) else []
                out = await _ambient_dismiss_issues(keys)
                results.append({"tool": tool, "args": args, "ok": True, "result": out[:300]})
                continue
            out = await toolbox.execute_tool(tool, args, str(user_id))
            results.append({"tool": tool, "args": args, "ok": True, "result": str(out)[:300]})
        except Exception as exc:
            results.append({"tool": tool, "args": args, "ok": False, "error": str(exc)})
            log_detail("ambient", "ACTION_ERR", tool=tool, error=str(exc))
    return results

