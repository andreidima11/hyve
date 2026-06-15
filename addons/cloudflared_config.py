"""Cloudflared tunnel ingress builder + optional Cloudflare API sync (token mode)."""

from __future__ import annotations

import base64
import json
import logging
import urllib.error
import urllib.request
from typing import Any

from core.network_utils import suggest_origin_url

log = logging.getLogger(__name__)

_CF_API = "https://api.cloudflare.com/client/v4"


def decode_tunnel_token(token: str) -> tuple[str, str]:
    """Return (account_id, tunnel_id) from a cloudflared install token."""
    raw_token = (token or "").strip()
    if not raw_token:
        raise ValueError("empty tunnel token")
    pad = "=" * (-len(raw_token) % 4)
    try:
        payload = json.loads(base64.urlsafe_b64decode(raw_token + pad))
    except (json.JSONDecodeError, ValueError) as exc:
        raise ValueError("invalid tunnel token encoding") from exc
    account = payload.get("a") or payload.get("AccountTag")
    tunnel = payload.get("t") or payload.get("TunnelID")
    if not account or not tunnel:
        raise ValueError("tunnel token missing account or tunnel id")
    return str(account), str(tunnel)


def resolve_effective_origin(origin_url: str | None) -> str:
    explicit = str(origin_url or "").strip()
    if explicit:
        return explicit
    return str(suggest_origin_url(prefer_lan=True)["origin_url"])


def build_ingress_rules(
    *,
    hostname: str,
    origin: str,
    additional_hosts_json: str = "[]",
    catch_all: str = "",
) -> list[dict[str, Any]]:
    ingress: list[dict[str, Any]] = []
    host = (hostname or "").strip()
    if host:
        ingress.append({"hostname": host, "service": origin})
    try:
        extra = json.loads(additional_hosts_json or "[]")
    except json.JSONDecodeError as exc:
        raise ValueError(f"additional_hosts JSON invalid: {exc}") from exc
    if not isinstance(extra, list):
        raise ValueError("additional_hosts must be a JSON array")
    for item in extra:
        if not isinstance(item, dict):
            continue
        extra_host = str(item.get("hostname") or "").strip()
        service = str(item.get("service") or "").strip()
        if not extra_host or not service:
            raise ValueError("each additional_hosts entry needs hostname and service")
        entry: dict[str, Any] = {"hostname": extra_host, "service": service}
        origin_req: dict[str, Any] = {}
        if item.get("disableChunkedEncoding") is True:
            origin_req["disableChunkedEncoding"] = True
        if origin_req:
            entry["originRequest"] = origin_req
        ingress.append(entry)
    catch = (catch_all or "").strip()
    if catch:
        ingress.append({"service": catch})
    else:
        ingress.append({"service": "http_status:404"})
    for rule in ingress:
        if str(rule.get("service", "")).startswith("http"):
            rule.setdefault("originRequest", {})["noTLSVerify"] = True
    return ingress


def sync_tunnel_ingress(
    *,
    tunnel_token: str,
    api_token: str,
    hostname: str,
    origin: str,
    additional_hosts_json: str = "[]",
    catch_all: str = "",
    timeout: float = 30,
) -> dict[str, Any]:
    """Push ingress config to Cloudflare for a remotely-managed tunnel."""
    account_id, tunnel_id = decode_tunnel_token(tunnel_token)
    api = (api_token or "").strip()
    if not api:
        raise ValueError("cloudflare api token required")
    host = (hostname or "").strip()
    if not host:
        raise ValueError("external_hostname required for Cloudflare sync")
    origin_url = (origin or "").strip()
    if not origin_url:
        raise ValueError("origin url required for Cloudflare sync")

    ingress = build_ingress_rules(
        hostname=host,
        origin=origin_url,
        additional_hosts_json=additional_hosts_json,
        catch_all=catch_all,
    )
    body = {
        "config": {
            "ingress": ingress,
            "warp-routing": {"enabled": False},
        }
    }
    url = f"{_CF_API}/accounts/{account_id}/cfd_tunnel/{tunnel_id}/configurations"
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        method="PUT",
        headers={
            "Authorization": f"Bearer {api}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            payload = json.loads(resp.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace") if exc.fp else str(exc)
        raise RuntimeError(f"Cloudflare API HTTP {exc.code}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Cloudflare API unreachable: {exc}") from exc

    if not payload.get("success", True):
        errors = payload.get("errors") or payload
        raise RuntimeError(f"Cloudflare API rejected config: {errors}")

    log.info(
        "Cloudflared ingress synced for %s -> %s (%d rules)",
        host,
        origin_url,
        len(ingress),
    )
    return {"hostname": host, "origin": origin_url, "ingress_rules": len(ingress)}


def maybe_sync_from_addon_config(config: dict[str, Any]) -> dict[str, Any] | None:
    """Sync Cloudflare ingress when token-mode settings are complete."""
    tunnel_token = str(config.get("tunnel_token") or "").strip()
    if not tunnel_token:
        return None
    sync_flag = config.get("sync_origin_to_cloudflare", True)
    if sync_flag in (False, "false", "0", 0):
        return None
    api_token = str(config.get("cloudflare_api_token") or "").strip()
    if not api_token:
        return None
    hostname = str(config.get("external_hostname") or "").strip()
    if not hostname:
        raise ValueError("external_hostname required to sync origin to Cloudflare")
    origin = resolve_effective_origin(str(config.get("origin_url") or ""))
    return sync_tunnel_ingress(
        tunnel_token=tunnel_token,
        api_token=api_token,
        hostname=hostname,
        origin=origin,
        additional_hosts_json=str(config.get("additional_hosts") or "[]"),
        catch_all=str(config.get("catch_all_service") or ""),
    )


if __name__ == "__main__":
    import argparse
    import sys

    parser = argparse.ArgumentParser(description="Sync cloudflared ingress to Cloudflare")
    parser.add_argument("--tunnel-token", required=True)
    parser.add_argument("--api-token", required=True)
    parser.add_argument("--hostname", required=True)
    parser.add_argument("--origin", required=True)
    parser.add_argument("--additional-hosts", default="[]")
    parser.add_argument("--catch-all", default="")
    args = parser.parse_args()
    try:
        result = sync_tunnel_ingress(
            tunnel_token=args.tunnel_token,
            api_token=args.api_token,
            hostname=args.hostname,
            origin=args.origin,
            additional_hosts_json=args.additional_hosts,
            catch_all=args.catch_all,
        )
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
    print(json.dumps(result))
