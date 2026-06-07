#!/usr/bin/env bash
set -euo pipefail

PORT="${1:-5000}"
RTSP_PORT="${2:-8554}"
WEBRTC_PORT="${3:-8555}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
BASE_DIR="$ROOT/output/addons/frigate"
CONFIG_DIR="$BASE_DIR/config"
MEDIA_DIR="$BASE_DIR/media"
DB_DIR="$BASE_DIR/db"
mkdir -p "$CONFIG_DIR" "$MEDIA_DIR" "$DB_DIR"

CONFIG_FILE="$CONFIG_DIR/config.yml"
IMAGE="ghcr.io/blakeblackshear/frigate:stable"
CONTAINER_NAME="hyve-frigate"

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

DOCKER_BIN="$(find_bin docker /opt/homebrew/bin/docker /usr/local/bin/docker || true)"
if [[ -z "$DOCKER_BIN" ]]; then
  echo "Docker nu este instalat. Reinstalează add-on-ul Frigate ca să-l aducem automat (Colima)." >&2
  exit 1
fi

if ! "$DOCKER_BIN" info >/dev/null 2>&1; then
  COLIMA_BIN="$(find_bin colima /opt/homebrew/bin/colima /usr/local/bin/colima || true)"
  if [[ -n "$COLIMA_BIN" ]]; then
    echo "Pornesc Colima (daemon Docker)..." >&2
    "$COLIMA_BIN" start >&2 || {
      echo "colima start a eșuat. Pornește manual cu: colima start" >&2
      exit 1
    }
  else
    echo "Docker daemon nu rulează și Colima nu este instalată. Reinstalează add-on-ul." >&2
    exit 1
  fi
fi

if [[ ! -f "$CONFIG_FILE" ]]; then
  cat > "$CONFIG_FILE" <<'EOF'
mqtt:
  enabled: false

cameras: {}

detectors:
  cpu1:
    type: cpu

record:
  enabled: false

snapshots:
  enabled: true
EOF
fi

# Remove any leftover container with the same name (stopped or running)
"$DOCKER_BIN" rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true

exec "$DOCKER_BIN" run --rm \
  --name "$CONTAINER_NAME" \
  --shm-size=128mb \
  -v "$CONFIG_FILE:/config/config.yml" \
  -v "$MEDIA_DIR:/media/frigate" \
  -v "$DB_DIR:/db" \
  -p "${PORT}:5000" \
  -p "${RTSP_PORT}:8554" \
  -p "${WEBRTC_PORT}:8555/tcp" \
  -p "${WEBRTC_PORT}:8555/udp" \
  "$IMAGE"
