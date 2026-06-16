#!/usr/bin/env bash
set -euo pipefail

WEB_PORT="${1:-8080}"
MQTT_HOST="${2:-localhost}"
MQTT_PORT="${3:-1883}"
MQTT_USER="${4:-}"
MQTT_PASSWORD="${5:-}"
SERIAL_PORT="${6:-/dev/ttyUSB0}"
SERIAL_ADAPTER="${7:-ember}"
PERMIT_JOIN="${8:-false}"
FRONTEND_ENABLED="${9:-true}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
BASE_DIR="$ROOT/output/addons/zigbee2mqtt"
DATA_DIR="$BASE_DIR/data"
RUNTIME_DIR="$BASE_DIR/runtime"
SHIM_DIR="$BASE_DIR/shims"
CONFIG_FILE="$DATA_DIR/configuration.yaml"
mkdir -p "$DATA_DIR" "$RUNTIME_DIR" "$SHIM_DIR"

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

NPM_BIN="$(find_bin npm /opt/homebrew/bin/npm /usr/local/bin/npm || true)"
NPX_BIN="$(find_bin npx /opt/homebrew/bin/npx /usr/local/bin/npx || true)"
Z2M_BIN="$RUNTIME_DIR/node_modules/.bin/zigbee2mqtt"
LOCAL_BIN_DIR="$RUNTIME_DIR/node_modules/.bin"
PACKAGE_DIR="$RUNTIME_DIR/node_modules/zigbee2mqtt"
HASH_FILE="$PACKAGE_DIR/dist/.hash"

cat > "$SHIM_DIR/git" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
chmod +x "$SHIM_DIR/git"
unset GIT_DIR GIT_WORK_TREE
export PATH="$SHIM_DIR:$LOCAL_BIN_DIR:$PATH"

bootstrap_runtime() {
  mkdir -p "$RUNTIME_DIR"
  if [[ ! -x "$LOCAL_BIN_DIR/pnpm" || ! -x "$Z2M_BIN" ]]; then
    if [[ -z "$NPM_BIN" ]]; then
      echo "npm nu este instalat. Instalează Node.js înainte de Zigbee2MQTT." >&2
      exit 1
    fi
    echo "Instalez prerechizitele Zigbee2MQTT..."
    "$NPM_BIN" install --prefix "$RUNTIME_DIR" --no-save --prefer-online pnpm@latest zigbee2mqtt@latest
  fi
}

cat > "$CONFIG_FILE" <<EOF
homeassistant:
  enabled: true
  discovery_topic: homeassistant
  status_topic: hyve/status
permit_join: ${PERMIT_JOIN}
mqtt:
  base_topic: zigbee2mqtt
  server: mqtt://${MQTT_HOST}:${MQTT_PORT}
EOF

if [[ -n "$MQTT_USER" ]]; then
  printf '  user: %s\n' "$MQTT_USER" >> "$CONFIG_FILE"
fi
if [[ -n "$MQTT_PASSWORD" ]]; then
  printf '  password: %s\n' "$MQTT_PASSWORD" >> "$CONFIG_FILE"
fi

cat >> "$CONFIG_FILE" <<EOF
frontend:
  enabled: ${FRONTEND_ENABLED}
  port: ${WEB_PORT}
EOF

if [[ -n "$SERIAL_PORT" && "$SERIAL_PORT" != "external" && "$SERIAL_PORT" != "none" ]]; then
  {
    echo "serial:"
    echo "  port: ${SERIAL_PORT}"
    if [[ -n "$SERIAL_ADAPTER" && "$SERIAL_ADAPTER" != "auto" && "$SERIAL_ADAPTER" != "none" ]]; then
      echo "  adapter: ${SERIAL_ADAPTER}"
    fi
  } >> "$CONFIG_FILE"
fi

bootstrap_runtime

if [[ -x "$Z2M_BIN" ]]; then
  export ZIGBEE2MQTT_DATA="$DATA_DIR"
  mkdir -p "$PACKAGE_DIR/dist"
  [[ -f "$HASH_FILE" ]] || printf 'unknown\n' > "$HASH_FILE"
  export GIT_CEILING_DIRECTORIES="$PACKAGE_DIR"
  cd "$PACKAGE_DIR"
  exec "$Z2M_BIN"
fi

if [[ -n "$NPX_BIN" ]]; then
  export ZIGBEE2MQTT_DATA="$DATA_DIR"
  export GIT_CEILING_DIRECTORIES="$RUNTIME_DIR"
  cd "$RUNTIME_DIR"
  exec "$NPX_BIN" --yes --prefix "$RUNTIME_DIR" zigbee2mqtt@latest
fi

echo "Zigbee2MQTT nu este instalat local. Rulează instalarea add-on-ului sau: npm install --prefix ./output/addons/zigbee2mqtt/runtime --no-save pnpm zigbee2mqtt" >&2
exit 1
