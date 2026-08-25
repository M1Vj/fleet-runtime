#!/bin/bash
set -euo pipefail
PLIST_LABEL="com.m1vj.fleet-auth-refresh"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"
FLEET_DIR="$HOME/Projects/fleet-runtime"
NODE_BIN="$(command -v node)"
GH_BIN="$(command -v gh)"
AUTH_FILE="$HOME/.local/share/opencode/auth.json"
if [[ "$NODE_BIN" != /* || ! -x "$NODE_BIN" ]]; then
  echo "node must resolve to an absolute executable path" >&2
  exit 1
fi
if [[ "$GH_BIN" != /* || ! -x "$GH_BIN" ]]; then
  echo "gh must resolve to an absolute executable path" >&2
  exit 1
fi

xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

FLEET_DIR_XML="$(xml_escape "$FLEET_DIR")"
NODE_BIN_XML="$(xml_escape "$NODE_BIN")"
GH_BIN_XML="$(xml_escape "$GH_BIN")"
AUTH_FILE_XML="$(xml_escape "$AUTH_FILE")"
LAUNCH_PATH_XML="$(xml_escape "$(dirname "$GH_BIN"):$(dirname "$NODE_BIN"):$PATH")"
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
    <string>${FLEET_DIR_XML}/scripts/refresh-auth-secret.mjs</string>
    <string>${AUTH_FILE_XML}</string>
  </array>
  <key>WorkingDirectory</key><string>${FLEET_DIR_XML}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>FLEET_GH_BIN</key><string>${GH_BIN_XML}</string>
    <key>PATH</key><string>${LAUNCH_PATH_XML}</string>
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
echo "installed ${PLIST_LABEL}: refreshes FLEET_OPENCODE_AUTH every 30min while the owner user session is active"
echo "uninstall: launchctl unload '$PLIST_PATH' && rm '$PLIST_PATH'"
