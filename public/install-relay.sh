#!/usr/bin/env bash
# &Shawarma Schedule — connect this computer's Hermes to your scheduling app.
#
#   curl -fsSL https://YOUR-APP/install-relay.sh | SHAWARMA_URL=https://YOUR-APP bash -s -- setup_YOUR_CODE
#
# Copy the exact command from the app: Manage → Chat Bot → Set up Hermes.
# The one-time setup code is traded for your private key, so the key never
# appears on screen. No tunnel, no open ports — only outgoing HTTPS.
#   1. Checks Node.js 18+ and Hermes are installed.
#   2. Saves the key to ~/.andshawarma/env (readable only by you).
#   3. Installs the schedule skill for Hermes (and Claude Code, if present).
#   4. Runs the relay as a background service that starts at login and
#      restarts itself (launchd on macOS, systemd on Linux).
#   5. Checks it can reach the app.
# Uninstall: curl -fsSL https://YOUR-APP/install-relay.sh | bash -s -- --uninstall
set -euo pipefail

APP_URL="${SHAWARMA_URL:-}"
DIR="$HOME/.andshawarma"
LABEL="ai.andshawarma.relay"
SKILL="andshawarma-schedule"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UNIT="$HOME/.config/systemd/user/andshawarma-relay.service"

say() { printf '\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

if [ "${1:-}" = "--uninstall" ]; then
  if [ "$(uname)" = "Darwin" ]; then
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
  else
    systemctl --user disable --now andshawarma-relay 2>/dev/null || true
    rm -f "$UNIT"
  fi
  rm -rf "$DIR" "$HOME/.hermes/skills/$SKILL" "$HOME/.claude/skills/$SKILL"
  say "&Shawarma Schedule relay removed."
  exit 0
fi

ARG="${1:-}"
case "$ARG" in setup_*|shwrm_*) ;; *) fail "Copy the full command from the app: Manage → Chat Bot → Set up Hermes.";; esac
[ -n "$APP_URL" ] || fail "Copy the full command from the app (it includes SHAWARMA_URL=...)."
APP_URL="${APP_URL%/}"

say "1/5 Checking Node.js and Hermes"
NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || fail "Node.js 18+ is required: https://nodejs.org (or: brew install node)"
[ "$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')" -ge 18 ] || fail "Node.js 18+ is required (found $("$NODE_BIN" -v))."
HERMES_BIN="$(command -v hermes || true)"
[ -z "$HERMES_BIN" ] && [ -x "$HOME/.local/bin/hermes" ] && HERMES_BIN="$HOME/.local/bin/hermes"
[ -n "$HERMES_BIN" ] || fail "Hermes isn't installed on this computer. Install it (https://github.com/NousResearch/hermes-agent), or choose Cloud AI in the app instead (Manage → Chat Bot)."
echo "   node: $NODE_BIN   hermes: $HERMES_BIN"

say "2/5 Saving your key"
if [ "${ARG#setup_}" != "$ARG" ]; then
  RESP="$(curl -sS -X POST -H 'Content-Type: application/json' -d "{\"code\":\"$ARG\"}" "$APP_URL/api/public/hermes-setup")" || fail "Could not reach $APP_URL. Check your internet connection and try again."
  KEY="$(printf '%s' "$RESP" | "$NODE_BIN" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);if(j.key){process.stdout.write(j.key)}else{console.error(j.error||"Setup failed.");process.exit(1)}}catch{console.error("Unexpected reply from the app.");process.exit(1)}})')" || fail "This setup code didn't work (it may have expired). In the app, click Set up Hermes again and use the new command."
else
  KEY="$ARG"
fi
mkdir -p "$DIR"
umask 077
cat > "$DIR/env" <<ENV
SHAWARMA_URL=$APP_URL
SHAWARMA_API_KEY=$KEY
HERMES_BIN=$HERMES_BIN
ENV
curl -fsSL "$APP_URL/schedule-relay.mjs" -o "$DIR/schedule-relay.mjs"
cat > "$DIR/run.sh" <<RUN
#!/usr/bin/env bash
set -a; . "$DIR/env"; set +a
exec "$NODE_BIN" "$DIR/schedule-relay.mjs"
RUN
chmod 700 "$DIR/run.sh"

say "3/5 Teaching Hermes (and Claude Code, if installed) about the schedule app"
mkdir -p "$HOME/.hermes/skills/$SKILL"
curl -fsSL "$APP_URL/hermes-skill/SKILL.md" -o "$HOME/.hermes/skills/$SKILL/SKILL.md"
if [ -d "$HOME/.claude" ] || command -v claude >/dev/null 2>&1; then
  mkdir -p "$HOME/.claude/skills/$SKILL"
  cp "$HOME/.hermes/skills/$SKILL/SKILL.md" "$HOME/.claude/skills/$SKILL/SKILL.md"
  echo "   Claude Code skill installed too."
fi

say "4/5 Installing the background service"
if [ "$(uname)" = "Darwin" ]; then
  mkdir -p "$(dirname "$PLIST")"
  cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$DIR/run.sh</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DIR/relay.log</string>
  <key>StandardErrorPath</key><string>$DIR/relay.log</string>
</dict></plist>
PL
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
else
  mkdir -p "$(dirname "$UNIT")"
  cat > "$UNIT" <<UN
[Unit]
Description=&Shawarma Schedule relay
[Service]
ExecStart=$DIR/run.sh
Restart=always
RestartSec=5
[Install]
WantedBy=default.target
UN
  systemctl --user daemon-reload
  systemctl --user enable --now andshawarma-relay
fi

say "5/5 Checking the connection"
if curl -fsS -H "Authorization: Bearer $KEY" "$APP_URL/api/agent/relay/inbox" >/dev/null; then
  say "Connected. Your schedule chat now answers through this computer's Hermes."
  echo "   Logs: $DIR/relay.log"
else
  fail "The app rejected the key. Click Set up Hermes again in the app and rerun the new command."
fi
