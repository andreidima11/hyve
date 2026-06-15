#!/usr/bin/env bash
# Cloudflared add-on — Cloudflare Tunnel for Hyve (HA-style local or token mode).
set -euo pipefail

TUNNEL_TOKEN="${1:-}"
EXTERNAL_HOSTNAME="${2:-}"
TUNNEL_NAME="${3:-hyve}"
ORIGIN_URL="${4:-}"
ADDITIONAL_HOSTS_JSON="${5:-[]}"
CATCH_ALL_SERVICE="${6:-}"
METRICS_PORT="${7:-36500}"
LOG_LEVEL="${8:-info}"
POST_QUANTUM="${9:-false}"
SYNC_ORIGIN_TO_CF="${10:-true}"
CLOUDFLARE_API_TOKEN="${11:-}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
BASE_DIR="$ROOT/output/addons/cloudflared"
DATA_DIR="$BASE_DIR/data"
CONFIG_FILE="$DATA_DIR/config.yml"
CERT_FILE="$DATA_DIR/cert.pem"
CREDS_FILE="$DATA_DIR/tunnel.json"
IMAGE="cloudflare/cloudflared:latest"
CONTAINER_NAME="hyve-cloudflared"

mkdir -p "$DATA_DIR"

find_bin() {
  local name="$1"
  shift || true
  for candidate in "$@" "$(command -v "$name" 2>/dev/null || true)"; do
    if [[ -n "$candidate" && -x "$candidate" ]]; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}

DOCKER_BIN="$(find_bin docker /usr/bin/docker /opt/homebrew/bin/docker /usr/local/bin/docker || true)"
if [[ -z "$DOCKER_BIN" ]]; then
  echo "Docker nu este instalat. Reinstalează add-on-ul Cloudflared." >&2
  exit 1
fi

ensure_docker_daemon() {
  if "$DOCKER_BIN" info >/dev/null 2>&1; then
    return 0
  fi
  COLIMA_BIN="$(find_bin colima /opt/homebrew/bin/colima /usr/local/bin/colima || true)"
  if [[ -n "$COLIMA_BIN" ]]; then
    echo "Pornesc Colima (daemon Docker)..." >&2
    "$COLIMA_BIN" start >&2 || {
      echo "colima start a eșuat. Pornește manual: colima start" >&2
      exit 1
    }
    return 0
  fi
  echo "Docker daemon nu rulează." >&2
  exit 1
}

ensure_docker_daemon

hyve_port() {
  python3 - "$ROOT/config.json" <<'PY'
import json, sys
path = sys.argv[1]
try:
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    print(int(data.get("port") or 8082))
except (OSError, ValueError, TypeError):
    print(8082)
PY
}

default_origin_url() {
  local port lan
  port="$(hyve_port)"
  if [[ -n "$ORIGIN_URL" ]]; then
    echo "$ORIGIN_URL"
    return
  fi
  lan="$(detect_lan_ip)"
  if [[ -n "$lan" ]]; then
    echo "http://${lan}:${port}"
    return
  fi
  if [[ "$(uname -s)" == "Darwin" ]]; then
    echo "http://host.docker.internal:${port}"
  else
    echo "http://127.0.0.1:${port}"
  fi
}

detect_lan_ip() {
  python3 - <<'PY'
import socket
try:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.connect(("8.8.8.8", 80))
    ip = str(s.getsockname()[0] or "").strip()
    print(ip if ip and ip not in {"127.0.0.1", "0.0.0.0"} else "")
except OSError:
    pass
PY
}

origin_reachable_from_host() {
  local url="$1"
  python3 - "$url" <<'PY'
import sys, urllib.request
url = sys.argv[1]
try:
    req = urllib.request.Request(url, method="GET")
    with urllib.request.urlopen(req, timeout=3) as resp:
        sys.exit(0 if resp.status < 500 else 1)
except Exception:
    sys.exit(1)
PY
}

# Same network namespace as cloudflared (--network host). On macOS/Colima this is
# the Linux VM, not the Mac host — localhost here ≠ browser localhost.
origin_reachable_from_docker() {
  local url="$1"
  "$DOCKER_BIN" run --rm --network host alpine:3.19 \
    wget -q -O /dev/null --timeout=5 "$url" 2>/dev/null
}

warn_token_mode_origin() {
  local port origin host_url docker_url host_ok=0 docker_ok=0 hdi_ok=0
  port="$(hyve_port)"
  origin="${ORIGIN_URL:-$(default_origin_url)}"
  host_url="http://127.0.0.1:${port}/"
  docker_url="http://host.docker.internal:${port}/"

  origin_reachable_from_host "$host_url" && host_ok=1
  origin_reachable_from_docker "$host_url" && docker_ok=1
  if [[ "$(uname -s)" == "Darwin" ]]; then
    origin_reachable_from_docker "$docker_url" && hdi_ok=1
  fi

  echo "────────────────────────────────────────────────────────" >&2
  echo "Mod token: originea (Public Hostname → Service) se setează în Cloudflare Zero Trust." >&2
  echo "Hyve pe port ${port}." >&2

  if (( host_ok && docker_ok )); then
    echo "✓ Hyve răspunde din host și din container Docker (folosește ${origin} în Cloudflare)." >&2
  elif (( host_ok && !docker_ok && hdi_ok )); then
    echo "⚠ localhost:${port} merge în browser, dar NU din containerul cloudflared (macOS + Docker/Colima)." >&2
    echo "  În Cloudflare → Public Hostname → Service, schimbă:" >&2
    echo "    http://localhost:${port}  →  http://host.docker.internal:${port}" >&2
    echo "  (sau IP-ul LAN al Mac-ului, ex. http://192.168.x.x:${port})" >&2
  elif (( host_ok && !docker_ok )); then
    echo "⚠ Hyve răspunde pe host, dar NU din rețeaua Docker (--network host)." >&2
    echo "  Setează în Cloudflare Service la: ${origin}" >&2
    if [[ "$(uname -s)" == "Darwin" ]]; then
      echo "  Pe macOS încearcă: http://host.docker.internal:${port}" >&2
    fi
  else
    echo "⚠ Hyve NU răspunde pe port ${port}." >&2
    echo "  Pornește Hyve, apoi setează în Cloudflare Service: ${origin}" >&2
  fi
  echo "────────────────────────────────────────────────────────" >&2
}

sync_token_mode_origin() {
  local origin
  origin="$(resolved_origin_url)"
  if [[ "$SYNC_ORIGIN_TO_CF" != "true" && "$SYNC_ORIGIN_TO_CF" != "1" ]]; then
    warn_token_dashboard_only "$origin"
    return 0
  fi
  if [[ -z "$CLOUDFLARE_API_TOKEN" ]]; then
    warn_token_dashboard_only "$origin"
    return 0
  fi
  if [[ -z "$EXTERNAL_HOSTNAME" ]]; then
    echo "⚠ Sync Cloudflare: completează «Hostname extern» (ex. hv.serverdma.ro)." >&2
    warn_token_dashboard_only "$origin"
    return 0
  fi
  echo "Actualizez originea în Cloudflare: ${EXTERNAL_HOSTNAME} → ${origin}..." >&2
  if python3 "$ROOT/addons/cloudflared_config.py" \
      --tunnel-token "$TUNNEL_TOKEN" \
      --api-token "$CLOUDFLARE_API_TOKEN" \
      --hostname "$EXTERNAL_HOSTNAME" \
      --origin "$origin" \
      --additional-hosts "$ADDITIONAL_HOSTS_JSON" \
      --catch-all "$CATCH_ALL_SERVICE"; then
    echo "✓ Cloudflare ingress actualizat. Logurile ar trebui să arate ${origin}" >&2
  else
    echo "⚠ Sync Cloudflare a eșuat — verifică API token și permisiuni Tunnel Edit." >&2
    warn_token_dashboard_only "$origin"
  fi
}

resolved_origin_url() {
  default_origin_url
}

warn_token_dashboard_only() {
  local origin="$1"
  echo "────────────────────────────────────────────────────────" >&2
  echo "⚠ Mod token fără sync Cloudflare: ingress-ul vine din dashboard." >&2
  echo "  Origine Hyve: ${origin}" >&2
  echo "  Logurile pot arăta încă http://localhost:PORT din Cloudflare." >&2
  echo "  Adaugă Cloudflare API token + Hostname extern, sau schimbă manual în Zero Trust." >&2
  echo "────────────────────────────────────────────────────────" >&2
}

cf_docker() {
  "$DOCKER_BIN" run --rm --network host \
    -v "${DATA_DIR}:/etc/cloudflared" \
    "$IMAGE" "$@"
}

cf_login() {
  "$DOCKER_BIN" run --rm --network host \
    -v "${DATA_DIR}:/home/nonroot/.cloudflared" \
    "$IMAGE" tunnel login
}

tunnel_uuid() {
  python3 - <<'PY' "$CREDS_FILE"
import json, sys
try:
    with open(sys.argv[1], encoding="utf-8") as fh:
        data = json.load(fh)
    print(data.get("TunnelID") or data.get("tunnelID") or "")
except (OSError, ValueError, KeyError):
    print("")
PY
}

validate_hostname() {
  local host="$1"
  [[ "$host" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$ ]]
}

require_local_config() {
  local has_host=0
  local has_extra=0
  local has_catch=0
  [[ -n "$EXTERNAL_HOSTNAME" ]] && has_host=1
  if [[ "$ADDITIONAL_HOSTS_JSON" != "[]" && -n "$ADDITIONAL_HOSTS_JSON" ]]; then
    has_extra=1
  fi
  [[ -n "$CATCH_ALL_SERVICE" ]] && has_catch=1
  if (( has_host == 0 && has_extra == 0 && has_catch == 0 )); then
    echo "Configurează tunnel_token SAU external_hostname / additional_hosts / catch_all_service." >&2
    exit 1
  fi
  if [[ -n "$EXTERNAL_HOSTNAME" ]] && ! validate_hostname "$EXTERNAL_HOSTNAME"; then
    echo "external_hostname invalid: $EXTERNAL_HOSTNAME (fără https:// sau port)" >&2
    exit 1
  fi
}

ensure_certificate() {
  if [[ -f "$CERT_FILE" ]]; then
    return 0
  fi
  echo "────────────────────────────────────────────────────────" >&2
  echo "Autentificare Cloudflare necesară (prima rulare)." >&2
  echo "Deschide URL-ul afișat mai jos într-un browser și autorizează domeniul." >&2
  echo "────────────────────────────────────────────────────────" >&2
  cf_login || {
    echo "cloudflared tunnel login a eșuat." >&2
    exit 1
  }
  if [[ ! -f "$CERT_FILE" ]]; then
    echo "cert.pem lipsește după login. Verifică logurile de mai sus." >&2
    exit 1
  fi
}

ensure_tunnel() {
  if [[ -f "$CREDS_FILE" ]]; then
    local uuid
    uuid="$(tunnel_uuid)"
    if [[ -n "$uuid" ]]; then
      echo "Folosesc tunel existent: $uuid" >&2
      return 0
    fi
  fi
  echo "Creez tunel Cloudflare: ${TUNNEL_NAME}..." >&2
  cf_docker tunnel --origincert /etc/cloudflared/cert.pem create "$TUNNEL_NAME" || {
    echo "Crearea tunelului a eșuat. Verifică dacă numele există deja în Cloudflare Zero Trust." >&2
    exit 1
  }
  # cloudflared create writes <uuid>.json — normalize to tunnel.json
  local cred
  cred="$(find "$DATA_DIR" -maxdepth 1 -name '*.json' ! -name 'tunnel.json' -print -quit || true)"
  if [[ -n "$cred" && -f "$cred" ]]; then
    mv -f "$cred" "$CREDS_FILE"
  fi
  if [[ ! -f "$CREDS_FILE" ]]; then
    echo "Fișierul de credențiale tunnel.json nu a fost creat." >&2
    exit 1
  fi
}

write_config() {
  local origin uuid
  origin="${ORIGIN_URL:-$(default_origin_url)}"
  uuid="$(tunnel_uuid)"
  if [[ -z "$uuid" ]]; then
    echo "Nu am găsit TunnelID în $CREDS_FILE" >&2
    exit 1
  fi

  python3 - <<'PY' "$CONFIG_FILE" "$uuid" "$CREDS_FILE" "$EXTERNAL_HOSTNAME" "$origin" "$ADDITIONAL_HOSTS_JSON" "$CATCH_ALL_SERVICE"
import json, sys
from pathlib import Path

config_path, tunnel_id, creds, hostname, origin, extra_raw, catch_all = sys.argv[1:8]
ingress = []
if hostname:
    ingress.append({"hostname": hostname, "service": origin})
try:
    extra = json.loads(extra_raw or "[]")
except json.JSONDecodeError as exc:
    raise SystemExit(f"additional_hosts JSON invalid: {exc}")
if not isinstance(extra, list):
    raise SystemExit("additional_hosts must be a JSON array")
for item in extra:
    if not isinstance(item, dict):
        continue
    host = str(item.get("hostname") or "").strip()
    service = str(item.get("service") or "").strip()
    if not host or not service:
        raise SystemExit("each additional_hosts entry needs hostname and service")
    entry = {"hostname": host, "service": service}
    origin_req = {}
    if item.get("disableChunkedEncoding") is True:
        origin_req["disableChunkedEncoding"] = True
    if origin_req:
        entry["originRequest"] = origin_req
    ingress.append(entry)
if catch_all:
    ingress.append({"service": catch_all})
else:
    ingress.append({"service": "http_status:404"})

for rule in ingress:
    if rule.get("service", "").startswith("http"):
        rule.setdefault("originRequest", {})["noTLSVerify"] = True

doc = {
    "tunnel": tunnel_id,
    "credentials-file": "/etc/cloudflared/tunnel.json",
    "ingress": ingress,
}
Path(config_path).write_text(json.dumps(doc, indent=2), encoding="utf-8")
print(f"Config scris: {config_path} ({len(ingress)} reguli ingress)")
PY
}

route_dns() {
  local uuid host
  uuid="$(tunnel_uuid)"
  if [[ -z "$uuid" ]]; then
    return 0
  fi
  if [[ -n "$EXTERNAL_HOSTNAME" ]]; then
    echo "Actualizez DNS pentru ${EXTERNAL_HOSTNAME}..." >&2
    cf_docker tunnel --origincert /etc/cloudflared/cert.pem route dns -f "$uuid" "$EXTERNAL_HOSTNAME" || {
      echo "Avertisment: route DNS pentru $EXTERNAL_HOSTNAME a eșuat (poate exista deja)." >&2
    }
  fi
  while IFS= read -r host; do
    [[ -z "$host" ]] && continue
    echo "Actualizez DNS pentru ${host}..." >&2
    cf_docker tunnel --origincert /etc/cloudflared/cert.pem route dns -f "$uuid" "$host" || {
      echo "Avertisment: route DNS pentru $host a eșuat." >&2
    }
  done < <(python3 - "$ADDITIONAL_HOSTS_JSON" <<'PY'
import json, sys
extra = json.loads(sys.argv[1] or "[]")
for item in extra:
    if isinstance(item, dict) and item.get("hostname"):
        print(item["hostname"])
PY
)
}

run_token_mode() {
  warn_token_mode_origin
  sync_token_mode_origin
  echo "Pornesc cloudflared (tunel remote / token)..." >&2
  "$DOCKER_BIN" rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  if [[ "$POST_QUANTUM" == "true" || "$POST_QUANTUM" == "1" ]]; then
    exec "$DOCKER_BIN" run --rm --name "$CONTAINER_NAME" --network host \
      "$IMAGE" tunnel --no-autoupdate --metrics "0.0.0.0:${METRICS_PORT}" --post-quantum run --token "$TUNNEL_TOKEN"
  fi
  exec "$DOCKER_BIN" run --rm --name "$CONTAINER_NAME" --network host \
    "$IMAGE" tunnel --no-autoupdate --metrics "0.0.0.0:${METRICS_PORT}" run --token "$TUNNEL_TOKEN"
}

run_local_mode() {
  require_local_config
  ensure_certificate
  ensure_tunnel
  write_config
  route_dns

  echo "Pornesc cloudflared (tunel local: ${TUNNEL_NAME})..." >&2
  "$DOCKER_BIN" rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  if [[ "$POST_QUANTUM" == "true" || "$POST_QUANTUM" == "1" ]]; then
    exec "$DOCKER_BIN" run --rm --name "$CONTAINER_NAME" --network host \
      -v "${DATA_DIR}:/etc/cloudflared" \
      "$IMAGE" tunnel --no-autoupdate --metrics "0.0.0.0:${METRICS_PORT}" --post-quantum \
      --origincert /etc/cloudflared/cert.pem \
      --config /etc/cloudflared/config.yml \
      --loglevel "$LOG_LEVEL" \
      run
  fi
  exec "$DOCKER_BIN" run --rm --name "$CONTAINER_NAME" --network host \
    -v "${DATA_DIR}:/etc/cloudflared" \
    "$IMAGE" tunnel --no-autoupdate --metrics "0.0.0.0:${METRICS_PORT}" \
    --origincert /etc/cloudflared/cert.pem \
    --config /etc/cloudflared/config.yml \
    --loglevel "$LOG_LEVEL" \
    run
}

if [[ -n "$TUNNEL_TOKEN" ]]; then
  run_token_mode
else
  run_local_mode
fi
