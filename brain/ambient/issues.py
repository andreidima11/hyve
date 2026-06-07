from __future__ import annotations

import time
from typing import Any

from core import i18n as core_i18n
from logger import log_detail

from brain.ambient import config, constants, entities, runtime

from brain.ambient.config import _cfg, _entity_source, _ignore_unavailable_entities, _ignored_sources, _mode, _should_skip_entity, is_enabled
from brain.ambient.entities import _domain, _entity_area, _entity_name, _get_upcoming_events, _get_weather_forecast, _integration_sync_issues, _is_long_running, _minutes_in_state, _snapshot
from brain.ambient.runtime import _load_state, _save_state

def _unavailable_clusters() -> list[dict[str, Any]]:
    """Group unavailable entities by integration source (one alert per source)."""
    snapshot = _snapshot()
    by_source: dict[str, list[str]] = {}
    for eid, ent in snapshot.items():
        if _entity_source(ent) in _ignored_sources():
            continue
        state = str(ent.get("state") or "").strip().lower()
        if state not in constants._SKIP_ENTITY_STATES:
            continue
        src = _entity_source(ent) or "unknown"
        by_source.setdefault(src, []).append(_entity_name(ent) or eid)

    clusters: list[dict[str, Any]] = []
    for src, names in sorted(by_source.items()):
        if not names:
            continue
        clusters.append({
            "key": f"unavailable:{src}",
            "kind": "unavailable",
            "source": src,
            "count": len(names),
            "examples": names[:5],
            "label": core_i18n.t("brain.ambient.issues.unavailable_entities", count=len(names), source=src),
        })
    return clusters

def _current_proactive_issues() -> tuple[list[dict[str, Any]], set[str]]:
    """Structured issues visible right now (sync failures + unavailable clusters)."""
    issues: list[dict[str, Any]] = []
    keys: set[str] = set()

    for row in _integration_sync_issues():
        key = f"sync:{row['slug']}"
        keys.add(key)
        issues.append({
            "key": key,
            "kind": "sync",
            "source": row["slug"],
            "error": row["error"],
            "label": core_i18n.t("brain.ambient.issues.sync_failed", slug=row["slug"]),
        })

    if not _ignore_unavailable_entities():
        for cluster in _unavailable_clusters():
            keys.add(cluster["key"])
            issues.append(cluster)

    return issues, keys

def _reconcile_notified_issues(current_keys: set[str]) -> None:
    """Forget issues that cleared — user can be told again if they return."""
    removed = [k for k in runtime._notified_issues if k not in current_keys]
    if not removed:
        return
    for key in removed:
        runtime._notified_issues.pop(key, None)
    _save_state()
    log_detail("ambient", "ISSUE_RESOLVED", keys=",".join(removed[:8]))

def _new_issue_keys(current_keys: set[str]) -> set[str]:
    return {key for key in current_keys if key not in runtime._notified_issues}

def _mark_issues_notified(issue_keys: set[str], *, title: str = "") -> None:
    if not issue_keys:
        return
    now = time.time()
    for key in issue_keys:
        runtime._notified_issues[key] = {
            "at": now,
            "title": str(title or "")[:120],
        }
    _save_state()

def _attach_issue_awareness(context: dict) -> set[str]:
    """Enrich context with new vs already-notified issues; return new issue keys."""
    all_issues, current_keys = _current_proactive_issues()
    _reconcile_notified_issues(current_keys)
    new_keys = _new_issue_keys(current_keys)

    context["proactive_issues"] = all_issues
    context["new_proactive_issues"] = [item for item in all_issues if item.get("key") in new_keys]
    context["already_notified_issues"] = [
        {"key": key, **(runtime._notified_issues.get(key) or {})}
        for key in sorted(current_keys)
        if key in runtime._notified_issues
    ]
    context["new_proactive_issue_keys"] = sorted(new_keys)
    context["proactive_policy"] = core_i18n.t("brain.ambient.proactive_policy")
    return new_keys

