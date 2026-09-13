#!/bin/bash
set -euo pipefail

PLIST_LABEL="com.m1vj.fleet-auth-refresh"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"

if [[ "${FLEET_DATA_CLASS:-private}" != "private" ]]; then
  echo "install-keepalive blocked: public data class cannot invoke private keepalive" >&2
  exit 4
fi

if [[ -z "${FLEET_CONTROL_CHECKOUT:-}" ]]; then
  echo "FLEET_CONTROL_CHECKOUT is required" >&2
  exit 2
fi
FLEET_DIR="$FLEET_CONTROL_CHECKOUT"
if [[ "$FLEET_DIR" != /* ]]; then
  echo "FLEET_CONTROL_CHECKOUT must be an absolute path" >&2
  exit 2
fi
if [[ ! -d "$FLEET_DIR" ]]; then
  echo "FLEET_CONTROL_CHECKOUT must point to an existing checkout" >&2
  exit 2
fi
if [[ ! -f "$FLEET_DIR/scripts/refresh-auth-secret.mjs" ]]; then
  echo "FLEET_CONTROL_CHECKOUT is missing scripts/refresh-auth-secret.mjs" >&2
  exit 2
fi

if [[ -z "${FLEET_CONTROL_REPOSITORY:-}" ]]; then
  echo "FLEET_CONTROL_REPOSITORY is required" >&2
  exit 2
fi
FLEET_REPOSITORY="$FLEET_CONTROL_REPOSITORY"
if [[ ! "$FLEET_REPOSITORY" =~ ^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$ ]]; then
  echo "FLEET_CONTROL_REPOSITORY must use owner/name form" >&2
  exit 2
fi

xml_escape() {
  local value="$1"
  value="${value//&/&amp;}"
  value="${value//</&lt;}"
  value="${value//>/&gt;}"
  value="${value//\"/&quot;}"
  value="${value//\'/&apos;}"
  printf '%s' "$value"
}

NODE_BIN="$(command -v node)"
AUTH_FILE="$HOME/.local/share/opencode/auth.json"
FLEET_DIR_XML="$(xml_escape "$FLEET_DIR")"
FLEET_REPOSITORY_XML="$(xml_escape "$FLEET_REPOSITORY")"
NODE_BIN_XML="$(xml_escape "$NODE_BIN")"
AUTH_FILE_XML="$(xml_escape "$AUTH_FILE")"

mkdir -p "$(dirname "$PLIST_PATH")"
cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN_XML}</string>
    <string>scripts/refresh-auth-secret.mjs</string>
    <string>${AUTH_FILE_XML}</string>
  </array>
  <key>WorkingDirectory</key><string>${FLEET_DIR_XML}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>FLEET_DATA_CLASS</key><string>private</string>
    <key>FLEET_CONTROL_REPOSITORY</key><string>${FLEET_REPOSITORY_XML}</string>
  </dict>
  <key>StartInterval</key><integer>1800</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>/tmp/fleet-auth-refresh.log</string>
  <key>StandardErrorPath</key><string>/tmp/fleet-auth-refresh.err</string>
</dict>
</plist>
EOF
launchctl unload "$PLIST_PATH" 2>/dev/null || true
launchctl load "$PLIST_PATH"
echo "installed ${PLIST_LABEL}: refreshes FLEET_OPENCODE_AUTH every 30min while this Mac is on"
echo "uninstall: launchctl unload '$PLIST_PATH' && rm '$PLIST_PATH'"
