from __future__ import annotations

import os
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import core.settings as settings


def _ok(message: str) -> None:
    print(f"[OK] {message}")


def _warn(message: str) -> None:
    print(f"[WARN] {message}")


def _fail(message: str) -> None:
    print(f"[FAIL] {message}")


def main() -> int:
    cfg = settings.CFG.get("fcm") or {}
    failures = 0
    warnings = 0

    enabled = bool(cfg.get("enabled"))
    if enabled:
        _ok("config fcm.enabled is true")
    else:
        _fail("config fcm.enabled is false")
        failures += 1

    transport_mode = str(cfg.get("transport_mode") or "hybrid").strip().lower()
    if transport_mode in ("hybrid", "websocket", "firebase"):
        _ok(f"config fcm.transport_mode is valid ({transport_mode})")
    else:
        _warn(f"config fcm.transport_mode is invalid ({transport_mode}); expected websocket|firebase|hybrid")
        warnings += 1

    websocket_enabled = bool(cfg.get("websocket_enabled", True))
    if websocket_enabled:
        _ok("config fcm.websocket_enabled is true")
    else:
        _warn("config fcm.websocket_enabled is false (WebSocket delivery disabled)")
        warnings += 1

    project_id = str(cfg.get("project_id") or "").strip()
    if project_id:
        _ok("config fcm.project_id is set")
    else:
        _warn("config fcm.project_id is empty (optional, but recommended)")
        warnings += 1

    env_path = str(os.environ.get("HYVE_FCM_SERVICE_ACCOUNT_PATH") or "").strip()
    cfg_path = str(cfg.get("service_account_path") or "").strip()
    service_path = env_path or cfg_path
    if service_path:
        if Path(service_path).expanduser().exists():
            source = "env" if env_path else "config"
            _ok(f"FCM service account file exists ({source})")
        else:
            _fail("FCM service account path is set but file does not exist")
            failures += 1
    else:
        _fail("FCM service account path missing; set HYVE_FCM_SERVICE_ACCOUNT_PATH or config fcm.service_account_path")
        failures += 1

    send_when_ws_disconnected = bool(cfg.get("send_when_ws_disconnected", True))
    if send_when_ws_disconnected:
        _ok("config fcm.send_when_ws_disconnected is true")
    else:
        _warn("config fcm.send_when_ws_disconnected is false (FCM fallback disabled)")
        warnings += 1

    google_services = ROOT / "android" / "Hyve" / "app" / "google-services.json"
    if google_services.exists():
        _ok("Android google-services.json found")
    else:
        _warn("Android google-services.json missing (required to build FCM in app)")
        warnings += 1

    print("")
    if failures:
        _fail(f"FCM checks failed with {failures} blocking issue(s) and {warnings} warning(s)")
        return 1

    if warnings:
        _warn(f"FCM checks passed with {warnings} warning(s)")
    else:
        _ok("FCM checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
