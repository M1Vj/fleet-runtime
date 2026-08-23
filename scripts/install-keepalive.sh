#!/bin/bash
set -euo pipefail
PLIST_LABEL="com.m1vj.fleet-auth-refresh"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"
FLEET_DIR="$HOME/Projects/fleet-control"
NODE_BIN="$(command -v node)"
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
    <string>cd ${FLEET_DIR} &amp;&amp; node scripts/refresh-auth-secret.mjs "$HOME/.local/share/opencode/auth.json"</string>
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
