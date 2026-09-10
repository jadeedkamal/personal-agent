# Architecture

Personal Agent runs on a single Azure Ubuntu 24.04 VM (hostname `test-agent`, `20.44.52.130`),
reachable as `https://personal-agent.duckdns.org` (DuckDNS dynamic DNS + Caddy for automatic
HTTPS + reverse proxy). SSH as `personalagent` with `test-agent_key.pem`.

*(This file merges what used to be a separate `knowledge-self.md` — consolidated here on
2026-09-10 so there's one architecture doc, not two competing ones. Re-derive details from the
code when precision matters — this is an orientation map, not a source of truth that overrides
what you read in the files.)*

## What this is
A self-hosted, installable PWA that gives its user a chat interface to an AI agent running with
full access to this machine (shell, files, and — via a shared MCP server — the GUI of a virtual
desktop). Single user, single shared password (plus optional Google SSO). The agent backing the
chat is selectable between three CLI engines — see "Multi-CLI engines" below — but everything about
auth, storage, the frontend, and the tool ecosystem is shared regardless of which one is active.

## Layout
- `server.js` — Express backend: auth (password + Google SSO), conversation storage, SSE
  streaming from whichever CLI engine is active, uploads, push notifications, secure-input
  relay, graceful-restart scheduling, the persistent-memory injection (see below). Everything
  of substance is in this one file.
- `public/` — frontend: `index.html`, `app.js` (vanilla JS, no framework), `styles.css`,
  per-theme `theme-<id>.css` files, `manifest.json`, `sw.js` (service worker), `vendor/marked.js`.
- `config/mcp.json` — MCP server config passed to every `claude` invocation via `--mcp-config`.
  Registers four servers: `gui`, `video-downloader`, `music-player`, `whatsapp`. Antigravity CLI
  and Codex CLI each have their own separate MCP registration (`agy mcp add` → config at
  `~/.gemini/config/mcp_config.json`; `codex mcp add` → `~/.codex/config.toml`) pointing at the
  *same* server files, so all three engines share identical tool capabilities — see below.
- `~/mcp-servers/gui-control/server.js` — the shared MCP server. Exposes GUI control tools
  (screenshot, move_mouse, click, drag, scroll, type_text, key_press, launch_app, list_windows,
  activate_window, get_screen_size) driving `xdotool`/`scrot` against Xvfb display `:99`, plus
  `request_secure_input`/`check_secure_input` (see below) and `restart_agent_app` (see below).
- `data/sessions.json` — flat JSON store of all conversations (id → {title, updatedAt, mode,
  messages[], antigravityConversationId?, codexThreadId?}). No database.
- `data/tool-images/` — images returned by tool results (e.g. screenshots) are written here and
  served back as static URLs, not inlined as base64.
- `data/push-subscriptions.json` — Web Push subscriptions (deduped by endpoint).
- `data/rate-limit.json` — last-known Claude account rate-limit snapshot (see Settings).
- `data/app-settings.json` — global `{ provider, model: { claude, antigravity } }` — which CLI
  engine and which model within it are currently active. Not per-conversation.
- `~/workspace/uploads/` — user file uploads (multer), served at `/uploads`.
- `docs/` and `memory/` — this app's own persistent-memory stores (see "Persistent memory" below).

## Conversation modes
- **Workspace mode** (default): cwd = `~/workspace`, general-purpose sandbox.
- **Improve mode** ("Improve the agent" button in sidebar): cwd = this repo, and
  `IMPROVE_SYSTEM_PROMPT` (defined in `server.js`) is appended (Claude: via
  `--append-system-prompt`; Antigravity: prepended into the prompt text), telling the agent it
  may read/edit/restart its own services. This is the mode used for self-modification work.

## Multi-CLI engines (Claude CLI, Antigravity CLI, Codex CLI)
Settings → "CLI Engine" picks the backend (`claude`, `antigravity`, or `codex`) globally; it
applies to the *next* message sent, in any conversation. The chat composer has a model-picker pill
above it listing models for whichever engine is currently active. All three are configured in
`data/app-settings.json`, read fresh on every `/api/chat/stream` call.

The abstraction lives entirely in the `PROVIDERS` object in `server.js`: each provider is
`{ command, buildArgs(ctx), parseLine(obj, gen, broadcast) }`. Everything else (persistence, SSE
relay to the browser, reattach-on-reconnect, push notifications, the interleaved text/tool block
rendering, the persistent-memory injection) works in terms of the same block/tool/`text_delta`
vocabulary regardless of engine — `parseLine` is the only place that needs to know the actual CLI
wire format. Adding a new CLI means adding one more `PROVIDERS` entry — nothing else needs to
change (this is exactly how Codex was added).

**Every provider's child process is spawned with `stdio: ['ignore', 'pipe', 'pipe']`** — stdin
explicitly closed, not just unwritten. Found while adding Codex: `codex exec` checks whether stdin
is piped and blocks reading it to EOF before doing *anything* (not even `thread.started` reaches
stdout); Node's default when `stdio` isn't specified is an open-but-never-written pipe, which never
sends EOF, so the child hung forever. Closing it explicitly is harmless for Claude/Antigravity too.

**Claude** (`claude` on `$PATH`): `-p <prompt> --output-format stream-json
--include-partial-messages --verbose --permission-mode bypassPermissions --mcp-config
config/mcp.json [--model <id>] [--append-system-prompt <IMPROVE_SYSTEM_PROMPT> if mode=improve]
--resume <id>|--session-id <id>`. Native multi-turn continuity via `--resume`/`--session-id`
using our own conversation UUID directly (Claude accepts an arbitrary client-chosen session id).

**Antigravity** (`agy`, binary at `~/.local/bin/agy`, NOT on `$PATH` by default so `server.js`
references it by full path): `-p <prompt> --output-format stream-json
--dangerously-skip-permissions [--model <id>] [--conversation <nativeId>]`. Unlike Claude, `agy`
generates its *own* conversation id on first use (in the `init` event) — you can't pick an
arbitrary one — so `server.js` stores whatever `agy` returns as
`convos[id].antigravityConversationId` and passes it back via `--conversation` on later turns
with the same provider. No `--append-system-prompt` equivalent, so Improve-mode system prompt is
prepended into the prompt text itself instead.

*Antigravity event schema* (NDJSON, one object per line): `{event:"init", conversation_id,
init:{model, cwd, tools[], permission_mode}}` once at start; `{event:"step_update",
step_update:{step_index, state:"ACTIVE"|"DONE", step_type:"user_input"|"agent_response"|"tool",
text_delta?, tool_name?, tool_info?:{parameters, output?}, usage?}}` per step — **`text_delta` is
genuinely incremental across both ACTIVE and DONE states for the same step_index** (concatenate
them, don't just take the DONE one, or you silently drop most of the text); `{event:"result",
result:{response, status, usage}}` once at the end. Tool calls appear as a single
`step_type:"tool"` with `state:"ACTIVE"` (full parameters already known, no separate delayed input
event) then `state:"DONE"` (`tool_info.output` as a plain string, not Claude's typed content-block
array — no image results from Antigravity's own built-ins today). `usage.thinking_tokens > 0` is
the only signal that reasoning happened — there's no separate visible thinking block like
Claude's.

**Codex** (`codex`, binary at `~/.local/bin/codex`, installed user-local via `npm install -g
@openai/codex --prefix ~/.local` since the machine's global npm prefix isn't user-writable —
NOT on `$PATH`, same reason as Antigravity): `exec [resume <thread_id>] --json
--skip-git-repo-check --dangerously-bypass-approvals-and-sandbox [--model <id>] [-c
model_reasoning_effort=<effort>] <prompt>`. `--skip-git-repo-check` because Workspace mode's cwd
(`~/workspace`) isn't a git repo, which `codex exec` otherwise refuses to run outside of. Reasoning
effort isn't a separate flag — it's a config override — so a model catalog entry may be
`<model>:<effort>` (e.g. `gpt-5.1-codex:high`) and `buildArgs` splits it back apart. Session
continuity works like Antigravity: `codex` generates its own thread id (`thread.started` event),
stored as `convos[id].codexThreadId` and passed back via `resume <thread_id>`. No
`--append-system-prompt` equivalent, so — like Antigravity — Improve-mode's system prompt is
prepended into the prompt text instead.

*Codex event schema* (`--json`, NDJSON): `{type:"thread.started", thread_id}` once; `{type:
"turn.started"}`; `{type:"item.started"|"item.completed", item:{id, type, ...}}` per item, where
`item.type` is one of `agent_message` (completed-only, full text in one shot — **no incremental
text deltas**, unlike both other engines), `reasoning` (signals thinking happened, same
no-visible-content treatment as the other two), `command_execution` (started with
`command`/`aggregated_output:""`/`exit_code:null`, completed with the filled-in output/exit code),
`mcp_tool_call` (started/completed, `result.content[]` is the *same* text/image content-block
shape as Claude's own tool results, just `data`/`mimeType` instead of `source.data`/`media_type`),
`file_change`/`web_search` (completed-only, single-shot — `parseLine` starts and finishes the tool
block in the same call, and must explicitly set `.done = true` since there's no separate
started-then-completed pair to do it); `{type:"turn.completed", usage}` once at the end;
`{type:"turn.failed", error}` / `{type:"error", message}` on failure (appended to the same
`stderrBuf` the close handler already checks, so it surfaces the same way a Claude/Antigravity
crash would).

**Auth for Antigravity is subscription-based (Google OAuth), not an API key.** Do not set
`modelProvider`/`GEMINI_API_KEY` in `~/.gemini/antigravity-cli/settings.json` — that switches it
to pay-per-token Google AI Studio billing instead of the user's Google AI Pro subscription quota.
If `agy` ever reports "not signed in," fix is an *interactive* login (caches credentials for
headless `-p` calls afterward): launch `agy` with no arguments as a detached service on the
virtual desktop, pick "Google OAuth," have the user complete sign-in via Live Desktop.

**Codex is not yet authenticated on this machine** (`codex login status` → "Not logged in").
Either `codex login` (interactive ChatGPT OAuth, same Live-Desktop pattern as Antigravity's Google
sign-in — caches to `~/.codex/auth.json`) or a `CODEX_API_KEY` env var (pay-per-token, not
subscription) needs to happen before the `codex` provider actually produces a reply instead of a
401 surfaced as an `error` SSE event. This is a deliberate stopping point, not an oversight —
picking/entering credentials is the user's call, same as it was for Antigravity's OAuth.

**Cross-engine tool parity**: the `gui` MCP server (and the other three in `config/mcp.json`) is
registered for *all three* engines from the exact same files, so any tool added there is
automatically available everywhere — Claude calls tools directly by name; Antigravity has one
generic `call_mcp_tool` meta-tool that dispatches to the same server; Codex exposes each server's
tools directly (as `mcp_tool_call` items, `server`+`tool` identifying which).

**Cross-conversation continuity when switching engines mid-conversation**: each provider keeps
its own efficient native session continuity turn-to-turn as long as the *same* provider keeps
handling the conversation. The moment the active provider differs from whoever handled the
previous assistant turn (tracked via a `provider` field on each assistant message), `server.js`
detects the switch and manually prepends a plain-text transcript of the whole conversation so
far, so the new engine isn't starting blind (costs extra tokens once, but is correct).

## Request flow (chat)
`POST /api/chat/stream` (requireAuth) → loads/creates the conversation in `sessions.json` → reads
the active provider+model from `data/app-settings.json` → prepends persistent-memory context and
any cross-engine transcript (above) → spawns the provider's CLI as a child process, tracked in an
in-memory `activeGenerations` map keyed by conversation id (this is what makes
reattach-after-disconnect and "don't kill the generation when the browser closes" work). The
server parses the CLI's stdout line by line via `provider.parseLine` and re-emits a shared SSE
vocabulary to the browser: `start`, `text_delta`, `tool_start`, `tool_input`, `tool_result` (with
any images), `thinking_start`, `done` (final reply + tool list), `error`, plus two out-of-band
event types — `secure_input_request`/`secure_input_resolved`. On child close, the assistant
message (with `provider`/`model` recorded) is appended to `sessions.json`, and a push notification
fires only if no SSE subscriber is currently attached.

## Virtual desktop / GUI control
- Xvfb (`:99`, 1600×900) + XFCE + x11vnc + noVNC, exposed at `/desktop` (gated by the same
  session cookie via Caddy `forward_auth` against `/api/authcheck`).
- "Live Desktop" (header toggle) embeds the noVNC stream directly above the chat (as an
  `<iframe>`, torn down — not just hidden — on close, to kill the underlying VNC/websocket
  connection), with a compact/full-history toggle and screenshot-image suppression while it's
  open (you're already watching live, so the gallery redundancy is hidden — other image types
  still show).
- **GUI automation gotchas learned from direct experience:**
  - Launching a GUI app via `sudo systemd-run --scope -- ...` ties its lifetime to the calling
    turn; it dies when the turn ends (observed repeatedly with Chromium). Use a real transient
    **service** instead: `sudo systemd-run --unit=<name> -- ...` (no `--scope`) — survives turn
    boundaries.
  - Chromium (snap package) needs to run as **root** in this environment or its snap-cgroup
    validation fails; `--uid=1000` breaks it. Non-snap GUI apps (e.g. `xfce4-terminal`) run fine
    as `personalagent` (`--uid=1000 --gid=1000`) and should default to that instead of root.
  - Stop/clean up transient login/admin-task services once done with them.
  - For any credential a browser reveals only via clipboard-copy button, read it back with
    `DISPLAY=:99 xclip -selection clipboard -o` rather than transcribing it off a screenshot —
    visually-similar characters are a real, silent failure mode.

## Secure input (credentials never touch the model)
`request_secure_input`/`check_secure_input` MCP tools let an agent ask the user for a sensitive
value (password, API key, OTP) without it ever appearing in chat text, the conversation
transcript, or `sessions.json`. Flow: the tool POSTs to `/internal/secure-input/create`
(localhost-only, gated by `INTERNAL_SHARED_SECRET`) → `server.js` broadcasts a
`secure_input_request` SSE event → the frontend shows a dedicated modal (masked input, visually
separate from the chat bubble UI) → the user submits via `/api/secure-input/:id/submit`
(session-authenticated) → the value sits in memory only, retrievable exactly once via polling,
then deleted. The MCP tool then types it directly into whatever's focused on the virtual desktop
via the same `xdotool` mechanism as `type_text`. **Design constraint learned the hard way**: the
tool call must return quickly (a short bounded poll, ~8s) rather than blocking for the whole
5-minute request lifetime — long-blocking tool calls don't reliably survive this environment's
between-turn process lifecycle, so `request_secure_input` returns a pending id you re-check later
via `check_secure_input` if the user hasn't submitted yet.

## Graceful restart
`restart_agent_app` MCP tool — prefer this over `sudo systemctl restart agent-app` directly. It
only sets an in-memory flag via `POST /internal/restart/request`; the actual `systemctl restart`
is deferred until *inside* a generation's own child-close handler, i.e. only once that turn's
response has fully broadcast to every subscriber and every connection has ended. Safe to call at
any point in a turn. (Exception: deploying a change to the restart mechanism itself, or to
`server.js` before this tool's own backend route exists, still needs the old manual approach once.)

## Other integrated services
- `whatsapp-bridge` (systemd) — whatsapp-web.js + Puppeteer/Chrome, localhost:4010, allow-listed
  phone numbers, shared-secret auth to the main backend.
- `passless` (systemd) — a virtual FIDO2 device. Present and running; its full role/security
  implications have not been thoroughly reviewed — worth a closer look before relying on it.
- GlobalProtect (PanGPS/PanGPA) — VPN client. Login is always done by the user manually through
  the Live Desktop view; the agent never types the credentials itself.
- Music (paste a link, download, list, play) and a general file manager (`/api/files/*`) — both
  reachable from sidebar-footer icons.

## Settings (in-app modal, gear icon in sidebar footer)
Fetches `/api/system-info` (username, CPU, RAM, GPU, disk — live from the machine), `/api/status`
(shows a "Google Account" row only when the session was authenticated via Google SSO),
`/api/usage-stats` (Claude's account-level rate-limit utilization, cached to
`data/rate-limit.json`; not available for Antigravity), and `/api/app-settings` (the CLI Engine
picker).

## Reverse proxy
Caddy (`/etc/caddy/Caddyfile`), host `personal-agent.duckdns.org`:
- `/` → `127.0.0.1:3000` (the Express app)
- `/desktop*` → `127.0.0.1:6080` (noVNC), gated by `forward_auth` against
  `127.0.0.1:3000/api/authcheck` — same session cookie protects both routes.

## Auth
Password (`AGENT_PASSWORD_HASH` env var, `salt:hash` scrypt, `timingSafeEqual` compare) or Google
SSO (`GET /api/auth/google` → consent → `/api/auth/google/callback` verifies the returned email
against `ALLOWED_GOOGLE_EMAIL` — critical, since without that check *any* Google account could
sign in once the OAuth consent screen leaves "Testing" mode) — either sets the same session flag.
Session cookie via `express-session`, `httpOnly`/`secure`/`sameSite:lax`, 30-day maxAge. Password
login rate-limited per IP (10 attempts/15 min). Never log or expose
`AGENT_PASSWORD_HASH`/`SESSION_SECRET`/`GOOGLE_CLIENT_SECRET`/`INTERNAL_SHARED_SECRET`/
`VAPID_PRIVATE_KEY`/any CLI's OAuth token.

## Persistent memory
Two stores, both plain markdown, both provider-agnostic (injected into `fullPrompt` upstream of
the `PROVIDERS` abstraction, so every CLI engine sees the same memory):
- `docs/` — what this app *is*: this file, `FEATURES.md`, `CHANGELOG.md`, `DECISIONS.md`.
- `memory/` — what's known about the *user and project*: `MEMORY.md` is a short always-injected
  index; individual notes live alongside it.
A nightly systemd timer (`memory-consolidate.timer` → `scripts/consolidate-memory.js`) reviews
conversations since its last run and updates `memory/` as a backstop, independent of whether the
live agent remembered to update it mid-conversation. See `DECISIONS.md` for why.

## Ground rules for self-modification (also in IMPROVE_SYSTEM_PROMPT)
- This app is the user's only interface to this machine — never leave it broken. `node -c` (or
  equivalent) any edited JS before restarting `agent-app`.
- Prefer small, testable changes over big rewrites.
- Never remove/weaken login/session auth (either path); never expose secrets.
- Prefer the `restart_agent_app` tool over a raw `systemctl restart` (above), and report what
  changed and why regardless of which mechanism is used.
- For destructive/irreversible/security-touching changes, explain the tradeoff rather than
  assuming consent.
- Before overwriting `server.js`/`public/*` from outside a live Improve session (e.g. deploying
  from a separate tool/session), re-read the live files first — a concurrent Improve session may
  have changed them since they were last read. See `DECISIONS.md`.
