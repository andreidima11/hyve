from __future__ import annotations

import re
from typing import Any

from smart_home_registry import controllable_domains, visible_domains

# Entity list caching lives in core.entity_catalog (ENTITIES_TTL=5s).
# Dashboard WS and state_observer share get_entities() via _available_entities().

_SWITCH_DOMAINS = controllable_domains()
_INFO_DOMAINS = visible_domains() - _SWITCH_DOMAINS
_VISIBLE_DOMAINS = visible_domains()
_DEFAULT_PREFS = {
    "layout_mode": "comfortable",
    "show_unavailable": True,
    "filter_mode": "all",
}
_DEFAULT_PANEL_TITLE = "Panou"
STANDALONE_PANEL_ID = "__standalone__"
_DEFAULT_PAGE_ID = "dashboard_home"
_DEFAULT_PAGE_TITLE = "Acasă"
_DEFAULT_DASHBOARD_ICON = "fas fa-table-cells-large"
_FA_STYLE_TOKENS = {
    "fas",
    "far",
    "fal",
    "fat",
    "fad",
    "fab",
    "fa-solid",
    "fa-regular",
    "fa-light",
    "fa-thin",
    "fa-duotone",
    "fa-brands",
}
_FA_ICON_RE = re.compile(r"^fa-[a-z0-9-]+$")
_MDI_ICON_RE = re.compile(r"^mdi[:\-][a-z0-9-]+$")
_MDI_NAME_RE = re.compile(r"^[a-z0-9-]+$")
_VISIBILITY_OPERATORS = {
    "is",
    "is_not",
    "==",
    "!=",
    ">",
    ">=",
    "<",
    "<=",
}
