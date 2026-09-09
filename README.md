# Personal Agent

A self-hosted, installable PWA that gives you a chat interface to an AI coding agent
running with full access to a machine — shell, files, and (via a shared MCP server) the
GUI of a virtual desktop you can watch live in-browser. Single user, password + optional
Google SSO. The backend can drive either the **Claude Code CLI** or the **Antigravity
CLI** as its underlying agent, selectable per-conversation from Settings.

For a deep dive into how the pieces fit together (request flow, dual-CLI abstraction,
secure-input, graceful restart, etc.), see [`knowledge-self.md`](./knowledge-self.md) —
written for an agent operating on this app's own source, but equally useful to a human.

## Architecture

```
Browser (PWA) ── Caddy (TLS reverse proxy) ── server.js (Express, port 3000)
                                                   │
                                                   ├─ spawns `claude` or `agy` (headless -p mode)
                                                   │    both configured with the same MCP server:
                                                   └─ mcp-servers/gui-control (xdotool/scrot against
                                                        a virtual desktop: Xvfb + xfce + x11vnc + noVNC)
```

- **`server.js`** — auth, conversation storage (flat JSON, no DB), SSE streaming from
  whichever CLI is active, uploads, web push notifications, secure-input relay, graceful
  self-restart.
- **`public/`** — vanilla-JS frontend, no build step, no framework.
- **`mcp-servers/gui-control/`** — MCP server exposing GUI-control tools (screenshot,
  click, type, etc.) driving `xdotool`/`scrot` against Xvfb display `:99`, registered
  identically with both CLI engines so tool capability is shared.
- Virtual desktop stack: `xvfb` → `xfce` → `x11vnc` → `novnc`, so the agent's GUI actions
  are watchable live in the browser.

## Prerequisites

- A Debian/Ubuntu machine (the installer uses `apt`) you have `sudo` on.
- A Claude subscription (Claude Code CLI) and/or a Google AI Pro subscription
  (Antigravity CLI) — you only strictly need one of the two.
- Optional: a domain name pointed at the machine, if you want HTTPS via Caddy instead of
  plain `http://host:3000`.

## Install

```
git clone <this-repo-url> agent-app
cd agent-app
./install.sh
```

The script is idempotent (safe to re-run) and handles:

- system packages (`xvfb`, `xfce4-session`, `x11vnc`, `novnc`, `xdotool`, `scrot`, `caddy`, `nodejs`)
- installing the Claude Code CLI (`npm i -g @anthropic-ai/claude-code`)
- `npm install` for both the backend and the `gui-control` MCP server
- generating `~/.secrets/agent.env` (prompts you for a login password, generates the
  session secret, internal shared secret, and VAPID push keys)
- generating `config/mcp.json` from `config/mcp.json.example`
- installing the systemd units (`systemd/*.service.tmpl`, templated with your user/paths)
- a narrowly-scoped passwordless sudo rule so the app can restart itself
  (`systemctl restart agent-app` only — see "Graceful restart" in `knowledge-self.md`)
- installing a Caddy config template (if `/etc/caddy/Caddyfile` doesn't already exist)

It prints a checklist of what's left, because these genuinely need a human:

1. **Claude CLI auth** — `claude setup-token`, paste the token into
   `~/.secrets/claude.env`, restart `agent-app`.
2. **Antigravity CLI** — no unattended installer; get `agy` from Google's official
   distribution, land it at `~/.local/bin/agy`, run it once interactively to complete
   Google OAuth (credentials are then cached for headless use), and register the same
   `gui-control` MCP server with it (`agy mcp add ...` — see `knowledge-self.md` for the
   exact JSON antigravity expects).
3. **Domain/TLS** — point DNS at the box, edit `/etc/caddy/Caddyfile`, reload Caddy.
4. **Google SSO** (optional) — OAuth client in Google Cloud Console, fill in the
   `GOOGLE_*`/`ALLOWED_GOOGLE_EMAIL` vars in `~/.secrets/agent.env`.

## Repo layout vs. runtime layout

Secrets and generated/runtime state deliberately live **outside** the repo and are
git-ignored:

| Repo (tracked)                    | Runtime (generated, not tracked)          |
|------------------------------------|--------------------------------------------|
| `config/mcp.json.example`          | `config/mcp.json` (real shared secret)      |
| `secrets/agent.env.example`        | `~/.secrets/agent.env`                      |
| `secrets/claude.env.example`       | `~/.secrets/claude.env`                     |
| `systemd/*.service.tmpl`           | `/etc/systemd/system/*.service`             |
| `Caddyfile.example`                | `/etc/caddy/Caddyfile`                      |
| `mcp-servers/gui-control/`         | symlinked to `~/mcp-servers/gui-control`    |
| —                                  | `data/` (conversations, uploads, images — per-install state) |

## Updating

```
cd agent-app
git pull
npm install --omit=dev
(cd mcp-servers/gui-control && npm install --omit=dev)
sudo systemctl restart agent-app
```

## Security notes

- The app is one shared password (plus optional single-email Google SSO) protecting full
  shell/file/GUI access to the host machine. Treat it like an SSH key: don't expose it
  without TLS, don't reuse the password elsewhere, keep `~/.secrets/*.env` at `chmod 600`.
- Nothing in `~/.secrets/`, `config/mcp.json`, or `data/` is committed — double check
  `git status` before committing if you ever hand-edit around these.
- The passwordless sudo rule the installer adds is scoped to exactly one command
  (`systemctl restart agent-app`), not blanket `NOPASSWD: ALL`.
