#!/bin/bash
set -euo pipefail
PLIST_LABEL="com.m1vj.fleet-auth-refresh"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"
FLEET_DIR="$HOME/Projects/fleet-runtime"
NODE_BIN="$(command -v node)"
AUTH_FILE="$HOME/.local/share/opencode/auth.json"
if [[ "$NODE_BIN" != /* ]]; then
  echo "node must resolve to an absolute executable path" >&2
  exit 1
fi

xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

FLEET_DIR_XML="$(xml_escape "$FLEET_DIR")"
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
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>cd "${FLEET_DIR_XML}" &amp;&amp; exec "${NODE_BIN_XML}" scripts/refresh-auth-secret.mjs "${AUTH_FILE_XML}"</string>
  </array>
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
