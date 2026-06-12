from __future__ import annotations

ENTRY_TEST_TIMEOUT_SECONDS = 50.0
MAMMOTION_ENTRY_TEST_TIMEOUT_SECONDS = 120.0
LIVE_POLL_INTERVAL_SEC = 2.0

SOURCE_META: dict[str, dict[str, str]] = {
    "pago": {"label": "Pago", "icon": "fa-credit-card", "color": "text-emerald-400"},
    "fusion_solar": {"label": "FusionSolar", "icon": "fa-solar-panel", "color": "text-amber-400"},
    "eon_romania": {"label": "E.ON România", "icon": "fa-bolt", "color": "text-rose-400"},
    "derived": {"label": "Derived", "icon": "fa-calculator", "color": "text-pink-400"},
}
