"""Local network helpers (LAN IP, Hyve origin URLs for add-ons)."""

from __future__ import annotations

import json
import socket
import sys
from pathlib import Path

_PROJECT_ROOT = Path(__file__).resolve().parents[1]
_DEFAULT_PORT = 8082


def detect_lan_ip() -> str | None:
    """Best-effort LAN IPv4 (route to 8.8.8.8 trick)."""
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            sock.connect(("8.8.8.8", 80))
            ip = str(sock.getsockname()[0] or "").strip()
        finally:
            sock.close()
    except OSError:
        return None
    if not ip or ip in {"127.0.0.1", "0.0.0.0"}:
        return None
    return ip


def read_hyve_port(config_path: Path | None = None, *, default: int = _DEFAULT_PORT) -> int:
    path = config_path or (_PROJECT_ROOT / "config.json")
    try:
        with path.open(encoding="utf-8") as fh:
            data = json.load(fh)
        port = int(data.get("port") or default)
        return port if 1 <= port <= 65535 else default
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return default


def suggest_origin_url(
    *,
    port: int | None = None,
    prefer_lan: bool = True,
    config_path: Path | None = None,
) -> dict[str, str | list[str]]:
    """Suggested Hyve origin URL(s) for cloudflared / reverse proxies."""
    resolved_port = port if port is not None else read_hyve_port(config_path)
    host_docker = f"http://host.docker.internal:{resolved_port}"
    loopback = f"http://127.0.0.1:{resolved_port}"

    primary: str | None = None
    alternatives: list[str] = []

    if prefer_lan:
        lan = detect_lan_ip()
        if lan:
            primary = f"http://{lan}:{resolved_port}"

    if sys.platform == "darwin":
        alternatives.append(host_docker)
    alternatives.append(loopback)

    if not primary:
        primary = host_docker if sys.platform == "darwin" else loopback

    return {
        "origin_url": primary,
        "origin_url_alternatives": [url for url in alternatives if url != primary],
    }
