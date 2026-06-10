#!/usr/bin/env python3
"""Report frontend t('key') usages missing from en.js or ro.js."""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
JS_ROOT = ROOT / "static" / "js"
T_CALL = re.compile(r"""\bt\(\s*['"]((?:[a-zA-Z0-9_]+\.)+[a-zA-Z0-9_]+)['"]""")


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
    en_keys = _flatten_lang_keys(JS_ROOT / "lang" / "en.js")
    ro_keys = _flatten_lang_keys(JS_ROOT / "lang" / "ro.js")
    used = _collect_t_keys()

    missing_en = sorted(k for k in used if k not in en_keys)
    missing_ro = sorted(k for k in used if k not in ro_keys)

    failed = False
    if missing_en:
        failed = True
        print("Missing from en.js:")
        for key in missing_en:
            print(f"  - {key}")
    if missing_ro:
        failed = True
        print("Missing from ro.js:")
        for key in missing_ro:
            print(f"  - {key}")

    if not failed:
        print(f"i18n key audit passed ({len(used)} t() keys checked)")
        return 0
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
