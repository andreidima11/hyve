#!/usr/bin/env python3
"""Report frontend t('key') usages missing from core + decentralised translation bundles."""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
JS_ROOT = ROOT / "static" / "js"
T_CALL = re.compile(r"""\bt\(\s*['"]((?:[a-zA-Z0-9_]+\.)+[a-zA-Z0-9_]+)['"]""")


def _flatten_dict(obj: object, prefix: str = "") -> set[str]:
    keys: set[str] = set()
    if not isinstance(obj, dict):
        return keys
    for key, value in obj.items():
        full = f"{prefix}.{key}" if prefix else str(key)
        if isinstance(value, dict):
            keys.update(_flatten_dict(value, full))
        else:
            keys.add(full)
    return keys


def _deep_merge(base: dict, overlay: dict) -> dict:
    for key, value in overlay.items():
        if key in base and isinstance(base[key], dict) and isinstance(value, dict):
            _deep_merge(base[key], value)
        else:
            base[key] = value
    return base


def _load_json(path: Path) -> dict:
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def _flatten_lang_keys(lang_file: Path) -> set[str]:
    script = f"""
import {{ pathToFileURL }} from 'node:url';
const mod = await import(pathToFileURL({str(lang_file)!r}).href);
const root = mod.default || mod;
function flat(obj, prefix = '') {{
  const out = [];
  for (const [k, v] of Object.entries(obj || {{}})) {{
    const key = prefix ? `${{prefix}}.${{k}}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...flat(v, key));
    else out.push(key);
  }}
  return out;
}}
console.log(flat(root).sort().join('\\n'));
"""
    out = subprocess.check_output(
        ["node", "--input-type=module", "-e", script],
        cwd=ROOT,
        text=True,
    )
    return {line.strip() for line in out.splitlines() if line.strip()}


def _platform_bundle_keys(lang: str) -> set[str]:
    keys: set[str] = set()
    i18n_root = ROOT / "core" / "i18n"
    for bundle_dir in sorted(i18n_root.iterdir()):
        if not bundle_dir.is_dir() or bundle_dir.name.startswith("_"):
            continue
        trans = bundle_dir / "translations" / f"{lang}.json"
        payload = _load_json(trans)
        if not payload and lang != "en":
            payload = _load_json(bundle_dir / "translations" / "en.json")
        if payload:
            keys.update(_flatten_dict({bundle_dir.name: payload}))
    return keys


def _component_bundle_keys(lang: str) -> set[str]:
    keys: set[str] = set()
    for root_name in ("components", "custom_components"):
        root = ROOT / root_name
        if not root.is_dir():
            continue
        for component_dir in sorted(root.iterdir()):
            if not component_dir.is_dir():
                continue
            trans = component_dir / "translations" / f"{lang}.json"
            payload = _load_json(trans)
            if not payload and lang != "en":
                payload = _load_json(component_dir / "translations" / "en.json")
            if payload:
                keys.update(_flatten_dict({"components": {component_dir.name: payload}}))
    return keys


def _addon_bundle_keys(lang: str) -> set[str]:
    keys: set[str] = set()
    shared = _load_json(ROOT / "addons" / "translations" / f"{lang}.json")
    if not shared and lang != "en":
        shared = _load_json(ROOT / "addons" / "translations" / "en.json")
    keys.update(_flatten_dict(shared))
    catalog = ROOT / "addons" / "available"
    if catalog.is_dir():
        for addon_dir in sorted(catalog.iterdir()):
            if not addon_dir.is_dir():
                continue
            trans = addon_dir / "translations" / f"{lang}.json"
            payload = _load_json(trans)
            if not payload and lang != "en":
                payload = _load_json(addon_dir / "translations" / "en.json")
            if payload:
                keys.update(_flatten_dict({"addons": {addon_dir.name: payload}}))
    return keys


def _all_lang_keys(lang: str) -> set[str]:
    mother = JS_ROOT / "lang" / f"{lang}.js"
    keys = _flatten_lang_keys(mother)
    keys.update(_platform_bundle_keys(lang))
    keys.update(_component_bundle_keys(lang))
    keys.update(_addon_bundle_keys(lang))
    return keys


def _collect_t_keys() -> set[str]:
    keys: set[str] = set()
    for path in JS_ROOT.rglob("*"):
        if path.suffix not in {".js", ".ts"}:
            continue
        if "lang" in path.parts:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            continue
        keys.update(T_CALL.findall(text))
    return keys


def main() -> int:
    en_keys = _all_lang_keys("en")
    ro_keys = _all_lang_keys("ro")
    used = _collect_t_keys()

    missing_en = sorted(k for k in used if k not in en_keys)
    missing_ro = sorted(k for k in used if k not in ro_keys)

    failed = False
    if missing_en:
        failed = True
        print("Missing from EN bundles:")
        for key in missing_en:
            print(f"  - {key}")
    if missing_ro:
        failed = True
        print("Missing from RO bundles:")
        for key in missing_ro:
            print(f"  - {key}")

    if not failed:
        print(f"i18n key audit passed ({len(used)} t() keys checked)")
        return 0
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
