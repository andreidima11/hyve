from __future__ import annotations

import json
import os
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import settings


def _read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _version_checks() -> list[str]:
    issues: list[str] = []
    app_version = settings.APP_VERSION
    config = _read_json(ROOT / "config.json")
    package = _read_json(ROOT / "package.json")
    package_lock = _read_json(ROOT / "package-lock.json")
    gradle_text = (ROOT / "android" / "HyveBridge" / "app" / "build.gradle.kts").read_text(encoding="utf-8")

    if config.get("version") != app_version:
        issues.append(f"config.json version mismatch: {config.get('version')} != {app_version}")
    if package.get("version") != app_version:
        issues.append(f"package.json version mismatch: {package.get('version')} != {app_version}")
    if package_lock.get("version") != app_version:
        issues.append(f"package-lock.json version mismatch: {package_lock.get('version')} != {app_version}")
    if ((package_lock.get("packages") or {}).get("") or {}).get("version") != app_version:
        issues.append("package-lock.json root package version mismatch")
    if f'versionName = "{app_version}"' not in gradle_text:
        issues.append("Android versionName mismatch")

    return issues


def _strict_runtime_checks() -> list[str]:
    env_view = {
        "HYVE_ENV": "production",
        "HYVE_SECRET_KEY": os.environ.get("HYVE_SECRET_KEY", ""),
    }
    return settings.get_runtime_requirement_errors(settings.CFG, env=env_view)


def main() -> int:
    issues = []
    issues.extend(_version_checks())
    issues.extend(_strict_runtime_checks())

    if issues:
        print("Release checks failed:")
        for issue in issues:
            print(f" - {issue}")
        if any(issue == "HYVE_SECRET_KEY is not set" for issue in issues):
            print("\nRemediation:")
            print(" - add HYVE_SECRET_KEY to .env")
            print(" - example: python -c \"import secrets; print(secrets.token_urlsafe(64))\"")
        return 1

    print(f"Release checks passed for {settings.APP_VERSION}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())