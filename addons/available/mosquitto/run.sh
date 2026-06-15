#!/usr/bin/env bash
set -euo pipefail

PORT="${1:-1883}"
WS_PORT="${2:-9001}"
ALLOW_ANON="${3:-true}"
USERNAME="${4:-}"
PASSWORD="${5:-}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
BASE_DIR="$ROOT/output/addons/mosquitto"
CONF_DIR="$BASE_DIR/config"
DATA_DIR="$BASE_DIR/data"
LOG_DIR="$BASE_DIR/log"
mkdir -p "$CONF_DIR" "$DATA_DIR" "$LOG_DIR"

CONF_FILE="$CONF_DIR/mosquitto.conf"
PASSWD_FILE="$CONF_DIR/passwd"

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

MOSQUITTO_BIN="$(find_bin mosquitto /usr/sbin/mosquitto /usr/bin/mosquitto /opt/homebrew/sbin/mosquitto /opt/homebrew/bin/mosquitto /usr/local/sbin/mosquitto /usr/local/bin/mosquitto || true)"
MOSQUITTO_PASSWD_BIN="$(find_bin mosquitto_passwd /usr/bin/mosquitto_passwd /opt/homebrew/bin/mosquitto_passwd /usr/local/bin/mosquitto_passwd || true)"

if [[ -z "$MOSQUITTO_BIN" ]]; then
  echo "Mosquitto nu este instalat. Rulează instalarea add-on-ului sau: brew install mosquitto (macOS) / apt install mosquitto (Linux)" >&2
  exit 1
fi

cat > "$CONF_FILE" <<EOF
persistence true
persistence_location ${DATA_DIR}/
log_dest stdout
listener ${PORT}
protocol mqtt
listener ${WS_PORT}
protocol websockets
EOF

if [[ -n "$USERNAME" && -n "$PASSWORD" && "$ALLOW_ANON" != "true" && "$ALLOW_ANON" != "1" ]]; then
  if [[ -z "$MOSQUITTO_PASSWD_BIN" ]]; then
    echo "Utilitarul mosquitto_passwd nu a fost găsit." >&2
    exit 1
  fi
  rm -f "$PASSWD_FILE"
  "$MOSQUITTO_PASSWD_BIN" -b -c "$PASSWD_FILE" "$USERNAME" "$PASSWORD"
  chmod 600 "$PASSWD_FILE"
  {
    echo "allow_anonymous false"
    echo "password_file ${PASSWD_FILE}"
  } >> "$CONF_FILE"
else
  echo "allow_anonymous true" >> "$CONF_FILE"
fi

exec "$MOSQUITTO_BIN" -c "$CONF_FILE"
