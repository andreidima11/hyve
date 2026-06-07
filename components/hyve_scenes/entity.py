"""Hyve Scenes — exposes user-defined scenes as virtual `scene.<slug>` entities.

Scenes are stored in the local DB (see `routers/scenes.py` and `models.Scene`).
This provider surfaces them in the unified entity catalog so they can be
used in dashboards (scene cards), referenced by voice intents, and selected
in automations alongside HA entities.

Scenes are activate-only — `state` is always "scening" (HA-style placeholder)
or last-activated timestamp.
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from integrations.base import BaseEntity
from integrations.component_import import import_sibling

log = logging.getLogger("integrations.scenes")

_extract_mod = import_sibling(Path(__file__).resolve().parent, "extract")
load_hyve_scene_entities = _extract_mod.load_hyve_scene_entities


class HyveScenesEntity(BaseEntity):
    slug = "hyve_scenes"
    label = "Hyve Scenes"
    description = "Scene utilizator — grupuri predefinite de acțiuni (ex: 'Seară film' aprinde anumite becuri și pornește TV-ul)."
    icon = "fa-film"
    color = "text-purple-400"
    supports_sync = False

    async def fetch_entities(self) -> dict[str, Any]:
        return {}

    def extract_entities(self, payload: Any) -> list[dict[str, Any]]:
        return []

    async def list_entities(self, store) -> list[dict[str, Any]]:
        del store
        return load_hyve_scene_entities(self.slug)

    def format_context(self, entities: dict[str, Any]) -> str:
        del entities
        return ""
