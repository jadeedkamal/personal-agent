---
name: reference-services
description: SSH, domain, and service quick reference for this VM
metadata:
  type: reference
---

- SSH: `ssh -i test-agent_key.pem personalagent@20.44.52.130`
- App: `https://personal-agent.duckdns.org` (DuckDNS + Caddy auto-HTTPS; Caddyfile at
  `/etc/caddy/Caddyfile`)
- App source: `~/agent-app` (backend `server.js`, frontend `public/`, MCP servers under
  `mcp-servers/`, this memory system under `docs/` and `memory/`)
- Key systemd services: `agent-app`, `xvfb`, `xfce`, `x11vnc`, `novnc`, `whatsapp-bridge`,
  `passless`, `caddy`
- Live desktop viewer: `https://personal-agent.duckdns.org/desktop` (session-cookie gated)
- Backups of risky deploys: `~/agent-app/.backups/<timestamp>/`
- Google SSO: Cloud project `personal-agent-507922`, OAuth consent screen is External/Testing
  (user's own email added as a test user), OAuth client redirect URI is
  `https://personal-agent.duckdns.org/api/auth/google/callback`, client ID/secret live in
  `.secrets/agent.env`. Login via Google only succeeds if the account email matches
  `ALLOWED_GOOGLE_EMAIL` in that same env file — that check is load-bearing, since the consent
  screen being in Testing mode alone doesn't restrict who can attempt sign-in.
- GUI automation note: Chromium launched via the normal `launch_app` tool call can get killed when
  an agent turn ends (same lifecycle issue as other background processes here) — for multi-step
  flows that must survive across turns (e.g. an OAuth login walked through live), launch it as a
  detached systemd service instead of a plain child process.
- Codex CLI (third chat provider, added 2026-09-10): binary at `~/.local/bin/codex` (installed via
  `npm install -g @openai/codex --prefix ~/.local`, not on `$PATH`), MCP servers registered via
  `codex mcp add <name> [--env K=V] -- node <path>` (config lives in `~/.codex/config.toml`, not
  `config/mcp.json`). **Not logged in yet** — `codex login status` says "Not logged in"; needs
  either interactive `codex login` (ChatGPT OAuth, do it via Live Desktop like Antigravity's Google
  sign-in) or a `CODEX_API_KEY` env var before picking "Codex CLI" in Settings does anything but
  surface a 401 as a chat error. See [[project-context]] and `docs/ARCHITECTURE.md` for the
  event-schema/plumbing details.
