#!/usr/bin/env bash
# Bootstrap Personal Agent (backend + GUI-control MCP server + virtual desktop stack)
# on a fresh Debian/Ubuntu machine. Safe to re-run — it skips anything already in place.
#
# What this does NOT do for you (must be finished by hand, see printed instructions at the end):
#   - Claude CLI login (interactive OAuth)
#   - Antigravity CLI install + login (interactive OAuth, no public unattended installer)
#   - Google SSO client setup (optional)
#   - Pointing a real domain at this machine + editing /etc/caddy/Caddyfile
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_USER="$(whoami)"
APP_HOME="$HOME"
SECRETS_DIR="$APP_HOME/.secrets"

echo "==> Installing system packages"
sudo apt-get update
sudo apt-get install -y \
  nodejs npm \
  xvfb xfce4-session dbus-x11 x11vnc novnc python3-websockify \
  xdotool scrot \
  caddy

echo "==> Installing Claude Code CLI (npm global)"
if ! command -v claude >/dev/null 2>&1; then
  sudo npm install -g @anthropic-ai/claude-code
else
  echo "    claude CLI already installed ($(claude --version 2>/dev/null || echo present)), skipping"
fi

echo "==> Installing node dependencies"
(cd "$REPO_DIR" && npm install --omit=dev)
(cd "$REPO_DIR/mcp-servers/gui-control" && npm install --omit=dev)

echo "==> Creating directories"
mkdir -p "$APP_HOME/workspace" "$APP_HOME/mcp-servers" "$SECRETS_DIR"
chmod 700 "$SECRETS_DIR"

echo "==> Linking gui-control MCP server into ~/mcp-servers"
ln -sfn "$REPO_DIR/mcp-servers/gui-control" "$APP_HOME/mcp-servers/gui-control"

INTERNAL_SECRET=""

if [ -f "$SECRETS_DIR/agent.env" ]; then
  echo "==> $SECRETS_DIR/agent.env already exists, leaving it alone"
  INTERNAL_SECRET="$(grep -oP '(?<=^INTERNAL_SHARED_SECRET=).*' "$SECRETS_DIR/agent.env" || true)"
else
  echo "==> Generating $SECRETS_DIR/agent.env"
  echo "    Pick a login password for the web app:"
  read -r -s -p "    Password: " AGENT_PASSWORD
  echo
  PASSWORD_HASH="$(node "$REPO_DIR/scripts/hash-password.js" "$AGENT_PASSWORD")"
  SESSION_SECRET="$(openssl rand -hex 32)"
  INTERNAL_SECRET="$(openssl rand -hex 24)"
  VAPID_OUT="$("$REPO_DIR/node_modules/.bin/web-push" generate-vapid-keys --json)"
  VAPID_PUBLIC="$(node -e "console.log(JSON.parse(process.argv[1]).publicKey)" "$VAPID_OUT")"
  VAPID_PRIVATE="$(node -e "console.log(JSON.parse(process.argv[1]).privateKey)" "$VAPID_OUT")"

  cat > "$SECRETS_DIR/agent.env" <<EOF
AGENT_PASSWORD_HASH=$PASSWORD_HASH
SESSION_SECRET=$SESSION_SECRET
AGENT_WORKSPACE=$APP_HOME/workspace
PORT=3000
INTERNAL_SHARED_SECRET=$INTERNAL_SECRET
VAPID_PUBLIC_KEY=$VAPID_PUBLIC
VAPID_PRIVATE_KEY=$VAPID_PRIVATE
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_OAUTH_REDIRECT_URI=
ALLOWED_GOOGLE_EMAIL=
EOF
  chmod 600 "$SECRETS_DIR/agent.env"
  unset AGENT_PASSWORD
fi

if [ -f "$SECRETS_DIR/claude.env" ]; then
  echo "==> $SECRETS_DIR/claude.env already exists, leaving it alone"
else
  echo "==> Creating empty $SECRETS_DIR/claude.env (you must fill this in, see instructions below)"
  cp "$REPO_DIR/secrets/claude.env.example" "$SECRETS_DIR/claude.env"
  chmod 600 "$SECRETS_DIR/claude.env"
fi

echo "==> Writing $REPO_DIR/config/mcp.json"
if [ -z "$INTERNAL_SECRET" ]; then
  echo "    (agent.env pre-existed without a readable secret — generating a fresh one)"
  INTERNAL_SECRET="$(openssl rand -hex 24)"
fi
sed -e "s#__HOME__#$APP_HOME#g" -e "s#__INTERNAL_SHARED_SECRET__#$INTERNAL_SECRET#g" \
  "$REPO_DIR/config/mcp.json.example" > "$REPO_DIR/config/mcp.json"

echo "==> Installing systemd units"
for tmpl in "$REPO_DIR"/systemd/*.service.tmpl; do
  name="$(basename "$tmpl" .tmpl)"
  sed -e "s#__USER__#$APP_USER#g" -e "s#__HOME__#$APP_HOME#g" -e "s#__REPO_DIR__#$REPO_DIR#g" \
    "$tmpl" | sudo tee "/etc/systemd/system/$name" > /dev/null
done
sudo systemctl daemon-reload
sudo systemctl enable --now xvfb xfce x11vnc novnc
sudo systemctl enable --now agent-app || echo "    agent-app did not start — fill in ~/.secrets/claude.env, then: sudo systemctl restart agent-app"

echo "==> Caddy reverse proxy"
if [ -f /etc/caddy/Caddyfile ]; then
  echo "    /etc/caddy/Caddyfile already exists, leaving it alone — see $REPO_DIR/Caddyfile.example"
else
  sudo cp "$REPO_DIR/Caddyfile.example" /etc/caddy/Caddyfile
  echo "    Installed a template at /etc/caddy/Caddyfile — edit the domain, then: sudo systemctl reload caddy"
fi

# sudo systemctl restart agent-app is used by the app's own "graceful restart" MCP tool
# (server.js's /internal/restart/request route) so it can restart itself after self-edits.
echo "==> Granting passwordless restart of agent-app to $APP_USER"
echo "$APP_USER ALL=(ALL) NOPASSWD: $(command -v systemctl) restart agent-app" | sudo tee /etc/sudoers.d/agent-app-restart > /dev/null
sudo chmod 440 /etc/sudoers.d/agent-app-restart

cat <<'EOF'

============================================================
Almost done. Finish these manually:

1. Claude CLI auth:
     claude setup-token
   Paste the printed token into ~/.secrets/claude.env as CLAUDE_CODE_OAUTH_TOKEN=...
   then: sudo systemctl restart agent-app

2. Antigravity CLI ("agy"):
   Install it per Google's official Antigravity distribution (there is no public apt/npm
   package as of this writing) so the binary ends up at ~/.local/bin/agy. Then log in
   interactively once (it caches credentials for headless use afterward):
     ~/.local/bin/agy
   and complete the Google OAuth flow it prints. Register the shared GUI-control MCP server
   with it too:
     agy mcp add gui node ~/mcp-servers/gui-control/server.js
   (with env GUI_DISPLAY=:99 and INTERNAL_SHARED_SECRET matching config/mcp.json — see
   README.md for the exact JSON antigravity expects in ~/.gemini/config/mcp_config.json)

3. Domain + TLS: point a DNS name at this machine, edit /etc/caddy/Caddyfile
   (see Caddyfile.example), then: sudo systemctl reload caddy

4. Optional Google SSO: create an OAuth client in Google Cloud Console and fill in
   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_OAUTH_REDIRECT_URI / ALLOWED_GOOGLE_EMAIL
   in ~/.secrets/agent.env, then restart agent-app.

Once claude.env has a real token, the app is reachable at http://<this-host>:3000
(or your domain, once Caddy is configured) — log in with the password you just set.
============================================================
EOF
