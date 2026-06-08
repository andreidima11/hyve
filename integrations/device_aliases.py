"""Local device name overrides for any integration.

Stored in ``config/device_aliases.yaml`` so it lives next to the user's
config and survives upgrades. Layout:

    aliases:
      mosquitto:
        "0xa4c138...": "Lampa Birou"
      pago:
        "card_1": "Card BT Gold"

Names override whatever the upstream provider returns for ``device_id``.
Entity-level ``name`` is left to the existing per-entity alias system; this
module only renames *devices* (the grouping key).

This module is the local source of truth for device display names, mirroring
Home Assistant's device_registry pattern: even when an upstream provider
(Z2M, etc.) loses or rejects the rename, the alias survives a restart and
the UI keeps showing the user's chosen name.
"""

from __future__ import annotations

import re
import threading
from pathlib import Path
from typing import Any

import yaml

_CONFIG_DIR = Path(__file__).resolve().parent.parent / "config"
_ALIASES_PATH = _CONFIG_DIR / "device_aliases.yaml"
_lock = threading.Lock()
_cache: dict[str, dict[str, str]] | None = None

# IEEE-64 addresses can show up as either ``0x<16 hex>`` (Z2M discovery) or
# the same value rendered in decimal (some payloads stringify the int).
# We normalise everything to the lowercase ``0x...`` form so a single key
# is used regardless of the source — otherwise the same physical device
# ends up under two YAML keys and the alias appears "lost" after restart.
_HEX_IEEE_RE = re.compile(r"^0x[0-9a-fA-F]{16}$")
_HEX_BARE_RE = re.compile(r"^[0-9a-fA-F]{16}$")
_DEC_IEEE_MIN = 1 << 32  # any plausible 64-bit IEEE is well above this
_DEC_IEEE_MAX = (1 << 64) - 1


def canonical_device_id(device_id: Any) -> str:
    """Return a canonical form of ``device_id`` (lowercase ``0x`` IEEE when
    we can recognise one; otherwise the trimmed string)."""
    if device_id is None:
        return ""
    raw = str(device_id).strip()
    if not raw:
        return ""
    if _HEX_IEEE_RE.match(raw):
        return raw.lower()
    if _HEX_BARE_RE.match(raw):
        return "0x" + raw.lower()
    if raw.isdigit():
        try:
            n = int(raw)
        except ValueError:
            return raw
        if _DEC_IEEE_MIN <= n <= _DEC_IEEE_MAX:
            return f"0x{n:016x}"
    return raw


def _load_unlocked() -> dict[str, dict[str, str]]:
    if not _ALIASES_PATH.exists():
        return {}
    try:
        raw = yaml.safe_load(_ALIASES_PATH.read_text()) or {}
    except Exception:
        return {}
    aliases = raw.get("aliases") or {}
    if not isinstance(aliases, dict):
        return {}
    out: dict[str, dict[str, str]] = {}
    needs_rewrite = False
    for slug, mapping in aliases.items():
        if not isinstance(mapping, dict):
            continue
        clean: dict[str, str] = {}
        for did, name in mapping.items():
            if not (did and isinstance(name, str) and name.strip()):
                continue
            key = canonical_device_id(did)
            if not key:
                continue
            if key != str(did):
                needs_rewrite = True
            # If two legacy keys collapse to the same canonical key, prefer
            # the longer / more recently-styled name (``0x...`` form is
            # written last when present, so its value wins on tie).
            existing = clean.get(key)
            if existing and existing != name.strip():
                # Prefer whichever entry came from a hex-style key, since
                # that's the format current discovery emits.
                if str(did).lower().startswith("0x"):
                    clean[key] = name.strip()
                # else: keep ``existing``
            else:
                clean[key] = name.strip()
        if clean:
            out[str(slug)] = clean
    if needs_rewrite:
        try:
            _save_unlocked(out)
        except Exception:
            pass
    return out


def _save_unlocked(data: dict[str, dict[str, str]]) -> None:
    _CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    payload = {"aliases": data}
    _ALIASES_PATH.write_text(yaml.safe_dump(payload, sort_keys=True, allow_unicode=True))


def _get_cache() -> dict[str, dict[str, str]]:
    global _cache
    if _cache is None:
        _cache = _load_unlocked()
    return _cache


def reload() -> None:
    """Force re-read from disk on the next call."""
    global _cache
    with _lock:
        _cache = None


def all_aliases() -> dict[str, dict[str, str]]:
    with _lock:
        return {slug: dict(m) for slug, m in _get_cache().items()}


def get_alias(slug: str, device_id: str) -> str | None:
    if not slug or not device_id:
        return None
    key = canonical_device_id(device_id)
    if not key:
        return None
    with _lock:
        return _get_cache().get(str(slug), {}).get(key)


def set_alias(slug: str, device_id: str, new_name: str) -> None:
    if not slug or not device_id:
        raise ValueError("slug and device_id are required")
    key = canonical_device_id(device_id)
    if not key:
        raise ValueError("device_id is empty after normalisation")
    with _lock:
        data = dict(_get_cache())
        bucket = dict(data.get(slug) or {})
        cleaned = (new_name or "").strip()
        if cleaned:
            bucket[key] = cleaned
        else:
            bucket.pop(key, None)
        if bucket:
            data[slug] = bucket
        else:
            data.pop(slug, None)
        _save_unlocked(data)
        global _cache
        _cache = data


def apply_to_entities(slug: str, entities: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Overlay device-level aliases onto a list of entity dicts.

    The alias replaces ``device_name`` (used for grouping) when present.
    Entity ``name`` is untouched — per-entity aliases are still authoritative.

    Some providers (mosquitto, pago) keep ``device_id`` only inside
    ``attributes``; others put it at the top level. We check both and
    write the override into both locations so downstream consumers see it
    regardless of which one they read.
    """
    aliases = all_aliases().get(slug) or {}
    if not aliases:
        return entities
    for ent in entities:
        attrs = ent.get("attributes") if isinstance(ent.get("attributes"), dict) else {}
        raw_did = ent.get("device_id") or attrs.get("device_id") or ""
        key = canonical_device_id(raw_did)
        if not key or key not in aliases:
            continue
        new_name = aliases[key]
        old_device_name = str(ent.get("device_name") or (attrs.get("device_name") if isinstance(attrs, dict) else "") or "")
        ent["device_name"] = new_name
        if isinstance(attrs, dict):
            attrs["device_name"] = new_name
            # Keep a normalised device_id on attributes so the UI/grouping
            # always sees the canonical form (helps when the upstream
            # payload still uses the legacy decimal IEEE).
            attrs["device_id"] = key
        if "device_id" in ent:
            ent["device_id"] = key
        # Rewrite the per-entity display name so "<old_device> <feature>"
        # becomes "<new_device> <feature>". Some providers compute the
        # display name once from the upstream device_name (which can be the
        # raw IEEE) and never refresh it; without this the entity titles
        # in the UI keep showing ``0xa4c1...`` even after a rename.
        cur_name = str(ent.get("name") or "")
        if cur_name:
            renamed = False
            if old_device_name and cur_name.lower().startswith(old_device_name.lower()):
                tail = cur_name[len(old_device_name):].strip()
                ent["name"] = f"{new_name} {tail}".strip() if tail else new_name
                renamed = True
            elif cur_name == raw_did or cur_name.lower() == key.lower():
                ent["name"] = new_name
                renamed = True
            elif cur_name.lower().startswith(key.lower()):
                tail = cur_name[len(key):].strip()
                ent["name"] = f"{new_name} {tail}".strip() if tail else new_name
                renamed = True
            if not renamed and not cur_name.lower().startswith(new_name.lower()):
                stale_names: list[str] = []
                if isinstance(attrs, dict):
                    for attr_key in ("zigbee_friendly", "friendly_name"):
                        stale = str(attrs.get(attr_key) or "").strip()
                        if stale and stale.lower() != new_name.lower():
                            stale_names.append(stale)
                try:
                    from core import entity_registry

                    stale_names.extend(
                        entity_registry._collect_old_friendly_names(
                            key,
                            exclude=new_name,
                        )
                    )
                except Exception:
                    pass
                old_match = None
                try:
                    from core import entity_registry

                    old_match = entity_registry._matching_old_friendly(
                        {
                            "name": cur_name,
                            "entity_id": ent.get("entity_id"),
                            "unique_id": ent.get("unique_id"),
                        },
                        stale_names,
                    )
                except Exception:
                    old_match = None
                if old_match:
                    tail = cur_name[len(old_match):].strip()
                    ent["name"] = f"{new_name} {tail}".strip() if tail else new_name
        # Rebuild HA-style ``entity_id`` from the new display name so the
        # user-visible id (``sensor.lampa_birou_temperature``) matches the
        # rename. Keep the original id available as ``unique_id`` so routing
        # by stable handle still resolves.
        try:
            from smart_home_registry import (
                KNOWN_DOMAINS,
                slugify_object_id,
            )
        except Exception:
            KNOWN_DOMAINS = None  # type: ignore[assignment]
            slugify_object_id = None  # type: ignore[assignment]
        if slugify_object_id is not None:
            domain = str(ent.get("domain") or "").strip().lower() or "sensor"
            if KNOWN_DOMAINS is not None and domain not in KNOWN_DOMAINS:
                domain = "sensor"
            current_eid = str(ent.get("entity_id") or "")
            new_display = str(ent.get("name") or new_name)
            new_eid = f"{domain}.{slugify_object_id(new_display)}"
            if current_eid and current_eid != new_eid:
                if not ent.get("unique_id"):
                    ent["unique_id"] = current_eid
                ent["entity_id"] = new_eid
    return entities
