#!/usr/bin/env python3
"""One-shot: move integrations/providers/*.py into components/<slug>/."""

from __future__ import annotations

import json
import re
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PROVIDERS = ROOT / "integrations" / "providers"
COMPONENTS = ROOT / "components"

# slug -> (entity source filename, entity class name, extra files: src -> dest)
BUNDLE: dict[str, dict] = {
    "pago": {"class": "PagoEntity", "entity": "pago.py"},
    "fusion_solar": {"class": "FusionSolarEntity", "entity": "fusion_solar.py"},
    "ariston_net": {"class": "AristonNetEntity", "entity": "ariston_net.py"},
    "eon_romania": {"class": "EonRomaniaEntity", "entity": "eon_romania.py"},
    "reteleelectrice": {"class": "ReteleElectriceEntity", "entity": "reteleelectrice.py"},
    "hyve_scenes": {"class": "HyveScenesEntity", "entity": "scenes.py"},
    "frigate": {"class": "FrigateEntity", "entity": "frigate.py"},
    "midea_ac": {"class": "MideaAcEntity", "entity": "midea_ac.py"},
    "xiaomi_home": {"class": "XiaomiHomeEntity", "entity": "xiaomi_home.py"},
    "roborock": {"class": "RoborockEntity", "entity": "roborock.py"},
    "tapo": {"class": "TapoEntity", "entity": "tapo.py"},
    "reolink": {
        "class": "ReolinkEntity",
        "entity": "reolink.py",
        "extra": {"reolink_registry.py": "registry.py"},
    },
    "mosquitto": {
        "class": "MosquittoEntity",
        "entity": "mosquitto.py",
        "extra": {"mosquitto_bridge.py": "bridge.py"},
    },
}

SKIP = {"open_meteo.py", "sun.py"}


def _label_from_source(path: Path) -> str:
    text = path.read_text(encoding="utf-8")
    m = re.search(r'^\s+label\s*=\s*["\']([^"\']+)["\']', text, re.M)
    return m.group(1) if m else path.stem.replace("_", " ").title()


def _patch_entity(slug: str, text: str) -> str:
    if slug == "reolink":
        text = text.replace(
            "from integrations.providers.reolink_registry import ReolinkSpec, all_specs, build_entities",
            "from pathlib import Path\n"
            "from integrations.component_import import import_sibling\n"
            "_registry = import_sibling(Path(__file__).resolve().parent, \"registry\")\n"
            "ReolinkSpec = _registry.ReolinkSpec\n"
            "all_specs = _registry.all_specs\n"
            "build_entities = _registry.build_entities",
        )
    if slug == "mosquitto":
        header = (
            "from pathlib import Path\n"
            "from integrations.component_import import import_sibling\n"
            "_bridge_mod = import_sibling(Path(__file__).resolve().parent, \"bridge\")\n\n"
        )
        if "_bridge_mod" not in text:
            text = text.replace(
                "from integrations.base import BaseEntity",
                header + "from integrations.base import BaseEntity",
                1,
            )
        text = text.replace(
            "from integrations.providers import mosquitto_bridge",
            "# bridge module loaded as _bridge_mod above",
        )
        text = text.replace("mosquitto_bridge.get_bridge", "_bridge_mod.get_bridge")
        text = text.replace("mosquitto_bridge.start_bridge", "_bridge_mod.start_bridge")
        text = text.replace("mosquitto_bridge.stop_bridge", "_bridge_mod.stop_bridge")
    return text


def _write_manifest(dest: Path, slug: str, label: str) -> None:
    manifest = {
        "domain": slug,
        "name": label,
        "version": "1.0.0",
        "integration_type": "entity",
        "dependencies": [],
    }
    (dest / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    init = dest / "__init__.py"
    if not init.exists():
        init.write_text(f'"""Bundled {label} integration (see entity.py)."""\n', encoding="utf-8")


def _entity_shim(slug: str, class_name: str) -> str:
    return f'''\
"""Legacy import path — implementation lives in components/{slug}/."""

from __future__ import annotations

from integrations.component_loader import get_component_entity_class

{class_name} = get_component_entity_class({slug!r})
if {class_name} is None:
    raise ImportError("{slug} component failed to load from components/{slug}/")

__all__ = ["{class_name}"]
'''


def _bridge_shim(slug: str, module: str, exports: list[str]) -> str:
    lines = [
        f'"""Legacy import path — implementation lives in components/{slug}/{module}.py."""',
        "",
        "from __future__ import annotations",
        "",
        "from integrations.component_import import import_sibling",
        "from integrations.component_paths import BUNDLED_COMPONENTS_DIR",
        "",
        f'_mod = import_sibling(BUNDLED_COMPONENTS_DIR / "{slug}", "{module}")',
        "",
    ]
    for name in exports:
        lines.append(f"{name} = _mod.{name}")
    lines.append("")
    lines.append(f"__all__ = {exports!r}")
    lines.append("")
    return "\n".join(lines)


def migrate() -> None:
    for slug, spec in BUNDLE.items():
        entity_src_name = spec["entity"]
        src_path = PROVIDERS / entity_src_name
        if not src_path.is_file():
            print(f"skip missing {src_path}")
            continue
        dest = COMPONENTS / slug
        dest.mkdir(parents=True, exist_ok=True)
        label = _label_from_source(src_path)
        _write_manifest(dest, slug, label)
        entity_text = _patch_entity(slug, src_path.read_text(encoding="utf-8"))
        (dest / "entity.py").write_text(entity_text, encoding="utf-8")
        for src_name, dest_name in (spec.get("extra") or {}).items():
            shutil.copy2(PROVIDERS / src_name, dest / dest_name)
        shim_path = PROVIDERS / entity_src_name
        shim_path.write_text(_entity_shim(slug, spec["class"]), encoding="utf-8")
        print(f"migrated {slug}")

    # Auxiliary module shims (keep legacy import paths)
    (PROVIDERS / "reolink_registry.py").write_text(
        _bridge_shim("reolink", "registry", ["ReolinkSpec", "all_specs", "build_entities"]),
        encoding="utf-8",
    )
    (PROVIDERS / "mosquitto_bridge.py").write_text(
        _bridge_shim("mosquitto", "bridge", ["MosquittoBridge", "get_bridge", "start_bridge", "stop_bridge", "slugify"]),
        encoding="utf-8",
    )
    # scenes.py shim lives at providers/scenes.py but slug is hyve_scenes
    scenes_shim = PROVIDERS / "scenes.py"
    if scenes_shim.is_file() and "get_component_entity_class" not in scenes_shim.read_text(encoding="utf-8"):
        scenes_shim.write_text(_entity_shim("hyve_scenes", "HyveScenesEntity"), encoding="utf-8")


if __name__ == "__main__":
    migrate()
