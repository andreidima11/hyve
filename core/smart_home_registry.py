from __future__ import annotations

import re
from typing import Any, Iterable


CONTROLLABLE_DOMAINS = frozenset({
    "light",
    "switch",
    "script",
    "input_boolean",
    "cover",
    "lock",
    "vacuum",
    "lawn_mower",
    "climate",
    "water_heater",
    "media_player",
    "fan",
    "number",
    "select",
    "button",
    "scene",
})

INFO_DOMAINS = frozenset({
    "sensor",
    "binary_sensor",
    "weather",
    "person",
    "sun",
    "device_tracker",
    "update",
    "image",
    "event",
    "camera",
})

VISIBLE_DOMAINS = CONTROLLABLE_DOMAINS | INFO_DOMAINS

# Full set of HA-style domains we accept on entity records. Anything outside
# this set is rewritten to ``sensor`` by ``normalize_entity_record``.
KNOWN_DOMAINS = frozenset(VISIBLE_DOMAINS | {
    "automation",
})


_OBJECT_ID_RE = re.compile(r"[^a-z0-9_]+")


def slugify_object_id(value: Any) -> str:
    """Convert any string into a Home Assistant compatible object id.

    Lowercases, replaces non ``[a-z0-9_]`` runs with underscores and trims
    leading/trailing underscores. Returns ``"unknown"`` when the input is
    empty after normalization.
    """
    text = str(value or "").strip().lower()
    text = _OBJECT_ID_RE.sub("_", text)
    text = re.sub(r"_+", "_", text).strip("_")
    return text or "unknown"


def make_entity_id(domain: str, *parts: Any) -> str:
    """Build a Home Assistant style ``<domain>.<object_id>`` identifier.

    All ``parts`` are slugified individually then joined with ``_`` so the
    resulting object id never contains stray separators (``:`` / ``.`` /
    spaces). The domain is forced into the known set; unknown domains fall
    back to ``sensor`` to keep the entity visible.
    """
    dom = str(domain or "").strip().lower()
    if dom not in KNOWN_DOMAINS:
        dom = "sensor"
    chunks = [slugify_object_id(part) for part in parts if part not in (None, "")]
    object_id = "_".join(chunk for chunk in chunks if chunk) or "unknown"
    return f"{dom}.{object_id}"


def normalize_entity_record(item: dict[str, Any], *, default_source: str = "") -> dict[str, Any]:
    """Mutate a raw integration entity dict to follow HA conventions.

    - ``entity_id`` becomes ``<domain>.<object_id>`` (slugified). The
      original value is preserved as ``unique_id`` so providers can still
      route control commands to their internal handles.
    - ``domain`` is constrained to ``KNOWN_DOMAINS`` (default ``sensor``).
    - ``source`` defaults to ``default_source`` when missing.

    Idempotent: records that already use the dotted form are left alone but
    still get a ``unique_id`` mirror.
    """
    raw_id = str(item.get("entity_id") or "").strip()
    domain = str(item.get("domain") or "").strip().lower() or entity_domain(raw_id) or "sensor"
    if domain not in KNOWN_DOMAINS:
        domain = "sensor"
    item["domain"] = domain

    if default_source and not item.get("source"):
        item["source"] = default_source

    # Preserve the original provider id as unique_id; it's the stable handle
    # used by control routers and history.
    if not item.get("unique_id"):
        item["unique_id"] = raw_id or item.get("entity_id") or ""

    if "." in raw_id and raw_id.split(".", 1)[0] in KNOWN_DOMAINS:
        # Already HA-style; just make sure the domain prefix matches.
        existing_domain = raw_id.split(".", 1)[0]
        if existing_domain != domain:
            object_id = raw_id.split(".", 1)[1]
            item["entity_id"] = f"{domain}.{object_id}"
        return item

    # Legacy ``provider:device:suffix`` (or any other shape) → derive a
    # deterministic object id from the original. The source slug is
    # included as a prefix so two integrations cannot collide.
    parts: list[str] = []
    src = str(item.get("source") or default_source or "").strip()
    if src:
        parts.append(src)
    if raw_id:
        # Strip the leading ``source:`` if it duplicates the source slug to
        # keep object ids tidy (e.g. ``midea_ac:12345:power`` with
        # source=midea_ac becomes ``midea_ac_12345_power``).
        body = raw_id
        if src and body.lower().startswith(f"{src.lower()}:"):
            body = body[len(src) + 1 :]
        parts.append(body)
    item["entity_id"] = make_entity_id(domain, *parts)
    return item


def entity_domain(entity_id: str) -> str:
    return entity_id.split(".", 1)[0] if "." in entity_id else ""


def is_controllable_domain(domain: str) -> bool:
    return str(domain or "").strip() in CONTROLLABLE_DOMAINS


def is_visible_domain(domain: str) -> bool:
    return str(domain or "").strip() in VISIBLE_DOMAINS


def is_allowed_smart_home_domain(domain: str) -> bool:
    return str(domain or "").strip() in VISIBLE_DOMAINS


def controllable_domains() -> set[str]:
    return set(CONTROLLABLE_DOMAINS)


def visible_domains() -> set[str]:
    return set(VISIBLE_DOMAINS)


def allowed_smart_home_domains() -> set[str]:
    return set(VISIBLE_DOMAINS)


def filter_domains(domains: Iterable[str], *, visible_only: bool = False, controllable_only: bool = False) -> list[str]:
    values = [str(domain or "").strip() for domain in domains]
    if controllable_only:
        return [domain for domain in values if is_controllable_domain(domain)]
    if visible_only:
        return [domain for domain in values if is_visible_domain(domain)]
    return [domain for domain in values if domain]