# Architecture

Personal Agent runs on a single Azure Ubuntu 24.04 VM (hostname `test-agent`, `20.44.52.130`),
reachable as `https://personal-agent.duckdns.org` (DuckDNS dynamic DNS + Caddy for automatic
HTTPS + reverse proxy). SSH as `personalagent` with `test-agent_key.pem`.

## Backend
- `~/agent-app/server.js` — Express app. Session-cookie auth (password + Google SSO, single
  allow-listed email), conversation storage (`data/sessions.json`), SSE streaming relay to
  whichever CLI provider is driving a given turn, file/image uploads, push notifications.
- Runs as systemd service `agent-app` (127.0.0.1:3000, proxied by Caddy). Restarting it drops
  any in-flight SSE stream — the code defers a self-requested restart until the current
  generation's response has fully finished sending (see DECISIONS.md).

## Frontend
- `~/agent-app/public/` — `index.html`, `app.js`, `styles.css`, per-theme `theme-<id>.css` files,
  `manifest.json` + `sw.js` (installable PWA, network-first service worker, auto-reloads clients
  when a new SW version activates — see DECISIONS.md).

## Conversation modes
- **workspace** (default) — cwd `~/workspace`. General-purpose assistant.
- **improve** — cwd `~/agent-app` (the app's own source). The agent can read/edit its own code
  and restart its own services. Entered via the "Improve the agent" sidebar button.

## Multi-provider
`PROVIDERS` in `server.js` abstracts which CLI actually answers a turn:
- `claude` — Claude Code CLI.
- `antigravity` — Google's Antigravity CLI (Gemini 3.x models).
Each provider supplies `buildArgs()` (its CLI flags) and `parseLine()` (its own NDJSON event
schema translated into the shared block/tool/text_delta vocabulary the rest of the app uses).
Adding a new CLI (e.g. Codex) means adding one more entry here — nothing else needs to change,
including the memory system (see below), which is injected upstream of this abstraction.

## Virtual desktop / GUI control
- Xvfb (`:99`) + XFCE + x11vnc + noVNC, exposed at `/desktop` (gated by the same session cookie
  via Caddy `forward_auth` against `/api/authcheck`).
- MCP server `~/agent-app/mcp-servers/gui-control/server.js` gives the agent real hands: 
  `screenshot`, `click`, `move_mouse`, `drag`, `scroll`, `type_text`, `key_press`, `launch_app`,
  `list_windows`, `activate_window`, plus `request_secure_input` / `check_secure_input`.
- "Live Desktop" (header toggle) embeds the noVNC stream directly above the chat, with a
  compact/full-history toggle and screenshot-image suppression while it's open (you're already
  watching live, so the gallery redundancy is hidden — other image types still show).

## Secure input (credentials never touch the model)
`/internal/secure-input/*` (shared-secret gated, called by the MCP tool) and
`/api/secure-input/*` (session-cookie gated, called by the browser) let the agent request a
password/OTP/etc. from the user through a modal in the actual app — the value is typed directly
into the focused desktop field via `xdotool` and is never included in the tool's return value, so
it never reaches the model's context, the chat transcript, or disk.

## Other integrated services
- `whatsapp-bridge` (systemd) — whatsapp-web.js + Puppeteer/Chrome, localhost:4010, allow-listed
  phone numbers, shared-secret auth to the main backend.
- `passless` (systemd) — a virtual FIDO2 device. Present and running; its full role/security
  implications have not been thoroughly reviewed yet — worth a closer look before relying on it.
- GlobalProtect (PanGPS/PanGPA) — VPN client. Login is always done by the user manually through
  the Live Desktop view; the agent never types the credentials itself.
- Music (paste a link, download, list, play) and a general file manager (`/api/files/*`) —
  both reachable from sidebar-footer icons.

## Persistent memory
See `docs/DECISIONS.md` for why this exists and how it's wired in, `memory/MEMORY.md` for the
current index of what's known about the user/project.
