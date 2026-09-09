# Knowledge: Self (Personal Agent app)

This file documents the app whose source lives in this directory, for the benefit of an
agent (either CLI engine — see below) operating in "Improve" mode (working directory =
this repo, not `~/workspace`). Re-derive details from the code when precision matters —
this is an orientation map, not a source of truth that overrides what you read in the files.

## What this is
A self-hosted, installable PWA that gives its user a chat interface to an AI agent running
with full access to this machine (shell, files, and — via a shared MCP server — the GUI of
a virtual desktop). Single user, single shared password (plus optional Google SSO). As of
2026-09-08 the agent backing the chat is selectable between two CLI engines — see "Dual CLI
engines" below — but everything about auth, storage, the frontend, and the tool ecosystem is
shared regardless of which one is active.

## Layout
- `server.js` — Express backend: auth (password + Google SSO), conversation storage, SSE
  streaming from whichever CLI engine is active, uploads, push notifications, secure-input
  relay, graceful-restart scheduling. Everything of substance is in this one file.
- `public/` — frontend: `index.html`, `app.js` (vanilla JS, no framework), `styles.css`,
  `manifest.json`, `sw.js` (service worker), `vendor/marked.js`.
- `config/mcp.json` — MCP server config passed to every `claude` invocation via
  `--mcp-config`. Registers one server: `gui`. Antigravity CLI has its own separate MCP
  registration (`agy mcp add`, config at `~/.gemini/config/mcp_config.json`) pointing at the
  *same* server file, so both engines share identical tool capabilities — see below.
- `~/mcp-servers/gui-control/server.js` — the shared MCP server. Exposes GUI control tools
  (screenshot, move_mouse, click, drag, scroll, type_text, key_press, launch_app,
  list_windows, activate_window, get_screen_size) driving `xdotool`/`scrot` against Xvfb
  display `:99`, plus two more: `request_secure_input`/`check_secure_input` (see below) and
  `restart_agent_app` (see below).
- `data/sessions.json` — flat JSON store of all conversations (id → {title, updatedAt, mode,
  messages[], antigravityConversationId?}). No database.
- `data/tool-images/` — images returned by tool results (e.g. screenshots) are written here
  and served back as static URLs, not inlined as base64.
- `data/push-subscriptions.json` — Web Push subscriptions (deduped by endpoint).
- `data/rate-limit.json` — last-known Claude account rate-limit snapshot (see Settings).
- `data/app-settings.json` — global `{ provider, model: { claude, antigravity } }`; which CLI
  engine and which model within it are currently active. Not per-conversation.
- `~/workspace/uploads/` — user file uploads (multer), served at `/uploads`.

## Dual CLI engines (Claude CLI vs Antigravity CLI)
Settings → "CLI Engine" picks the backend (`claude` or `antigravity`) globally; it applies to
the *next* message sent, in any conversation. The chat composer has a model-picker pill above
it listing models for whichever engine is currently active. Both are configured in
`data/app-settings.json`, read fresh on every `/api/chat/stream` call.

The abstraction lives entirely in the `PROVIDERS` object in `server.js`: each provider is
`{ command, buildArgs(ctx), parseLine(obj, gen, broadcast) }`. Everything else (persistence,
SSE relay to the browser, reattach-on-reconnect, push notifications, the interleaved
text/tool block rendering) works in terms of the same block/tool/`text_delta` vocabulary
regardless of engine — `parseLine` is the only place that needs to know the actual CLI wire
format.

**Claude** (`claude` on `$PATH`): `-p <prompt> --output-format stream-json
--include-partial-messages --verbose --permission-mode bypassPermissions --mcp-config
config/mcp.json [--model <id>] [--append-system-prompt <IMPROVE_SYSTEM_PROMPT> if
mode=improve] --resume <id>|--session-id <id>`. Native multi-turn continuity via
`--resume`/`--session-id` using our own conversation UUID directly (Claude accepts an
arbitrary client-chosen session id).

**Antigravity** (`agy`, binary at `~/.local/bin/agy`, NOT on `$PATH` by default so
`server.js` references it by full path): `-p <prompt> --output-format stream-json
--dangerously-skip-permissions [--model <id>] [--conversation <nativeId>]`. Unlike Claude,
`agy` generates its *own* conversation id on first use (in the `init` event) — you can't pick
an arbitrary one — so `server.js` stores whatever `agy` returns as
`convos[id].antigravityConversationId` and passes it back via `--conversation` on later
turns with the same provider. No `--append-system-prompt` equivalent, so Improve-mode system
prompt is prepended into the prompt text itself instead.

*Antigravity event schema* (NDJSON, one object per line): `{event:"init", conversation_id,
init:{model, cwd, tools[], permission_mode}}` once at start; `{event:"step_update",
step_update:{step_index, state:"ACTIVE"|"DONE", step_type:"user_input"|"agent_response"|
"tool", text_delta?, tool_name?, tool_info?:{parameters, output?}, usage?}}` per step —
**`text_delta` is genuinely incremental across both ACTIVE and DONE states for the same
step_index** (e.g. ACTIVE carries `"OK"`, the following DONE for that same step carries
`"\n"` — concatenate them, don't just take the DONE one, or you silently drop most of the
text); `{event:"result", result:{response, status, usage}}` once at the end. Tool calls
appear as a single `step_type:"tool"` with `state:"ACTIVE"` (full parameters already known
at this point, no separate delayed input event) then `state:"DONE"` (with `tool_info.output`
as a plain string, not Claude's typed content-block array — no image results from
Antigravity's own built-ins today). `usage.thinking_tokens > 0` is the only signal that
reasoning/thinking happened — there's no separate visible thinking content block like
Claude's, so `usedThinking` is inferred from that instead.

**Auth for Antigravity is subscription-based (Google OAuth), not an API key.** Do not set
`modelProvider`/`GEMINI_API_KEY` in `~/.gemini/antigravity-cli/settings.json` — that switches
it to pay-per-token Google AI Studio billing instead of the user's Google AI Pro subscription
quota. If `agy` ever reports "not signed in," the fix is an *interactive* login (it caches
credentials for headless `-p` calls afterward): launch `agy` with no arguments in a terminal
on the virtual desktop (as a detached `systemd-run --unit=... ` service, NOT `--scope` — see
"GUI automation gotchas" below), pick "Google OAuth" at the prompt, and have the user complete
the browser sign-in via Live Desktop (open the printed URL in a fresh Chromium if it doesn't
auto-launch one — it usually doesn't in this headless setup). Do not touch
`~/.gemini/antigravity-cli/settings.json` or `GEMINI_API_KEY` as part of that flow.

**Cross-engine tool parity**: the `gui` MCP server is registered for *both* engines from the
exact same file (`~/mcp-servers/gui-control/server.js`), so any tool added there is
automatically available to both — Claude calls tools directly by name; Antigravity has one
generic `call_mcp_tool` meta-tool (`{ServerName, ToolName, Arguments}`) that dispatches to
the same server. Verified working end-to-end for `get_screen_size` and (implicitly)
everything else in that file.

**Cross-conversation continuity/memory when switching engines mid-conversation**: each
provider keeps its own efficient native session continuity turn-to-turn (cheap, cached) as
long as the *same* provider keeps handling the conversation. The moment the active provider
differs from whoever handled the previous assistant turn (tracked via a `provider` field
stored on each assistant message), `server.js` detects the switch and manually prepends a
plain-text transcript of the whole conversation so far into the prompt, so the new engine
isn't starting blind. This costs extra tokens on a switch (full history re-sent once) but is
correct regardless of how often engines get switched. Separately, whenever Antigravity is
active, this file being read isn't itself injected — but `MEMORY.md` (the Claude-side
auto-memory index, `~/.claude/projects/-home-personalagent-agent-app/memory/MEMORY.md`) *is*
prepended as context on every Antigravity turn, since Antigravity has no native equivalent
and would otherwise be blind to anything Claude has learned. Claude already has native access
to its own memory system, so nothing extra is injected for it.

## Request flow (chat)
`POST /api/chat/stream` (requireAuth) → loads/creates the conversation in `sessions.json` →
reads the active provider+model from `data/app-settings.json` → builds the manual
cross-engine context preamble if needed (above) → spawns the provider's CLI as a child
process, tracked in an in-memory `activeGenerations` map keyed by conversation id (this is
what makes reattach-after-disconnect and "don't kill the generation when the browser closes"
work — see Frontend notes). The server parses the CLI's stdout line by line via
`provider.parseLine` and re-emits a shared SSE vocabulary to the browser: `start`,
`text_delta`, `tool_start`, `tool_input`, `tool_result` (with any images), `thinking_start`,
`done` (final reply + tool list), `error`, plus two out-of-band event types unrelated to any
one generation — `secure_input_request`/`secure_input_resolved` (see below). On child close,
the assistant message (with `provider`/`model` recorded) is appended to `sessions.json`, and
a push notification fires *only if no SSE subscriber is currently attached* (mirrors "don't
notify about a conversation you already have open").

Key point: the server's `sessions.json` is the durable record and (for cross-engine
switches) the source of injected context — but for same-engine continuation, multi-turn
context is still maintained natively by the CLI itself via `--resume`/`--session-id`
(Claude) or `--conversation` (Antigravity), not reconstructed from stored messages.

## Two modes
- **Workspace mode** (default): cwd = `~/workspace`, general-purpose sandbox.
- **Improve mode** ("Improve the agent" button in sidebar): cwd = this repo, and
  `IMPROVE_SYSTEM_PROMPT` (defined in `server.js`) is appended (Claude: via
  `--append-system-prompt`; Antigravity: prepended into the prompt text), telling the agent
  it may read/edit/restart its own services. This is the mode used for self-modification work.

## Settings (in-app modal, gear icon in sidebar footer)
Fetches `/api/system-info` (username, CPU, RAM, GPU, disk — live from the actual machine),
`/api/status` (shows a "Google Account" row only when the current session was authenticated
via Google SSO, not password), `/api/usage-stats` (Claude's actual account-level rate-limit
utilization/reset time for the 5-hour and 7-day windows — sourced from a `rate_limit_event`
the `claude` CLI emits mid-stream, cached to `data/rate-limit.json`; not available for
Antigravity), and `/api/app-settings` (the CLI Engine picker, a plain `<select>` appended
after the static rows since it needs to be interactive).

## Push notifications
VAPID keys in `.secrets/agent.env`; subscriptions in `data/push-subscriptions.json`. Service
worker (`sw.js`) shows the notification and, on click, focuses an existing tab and messages
it to switch conversations (or opens `/?c=<id>` if no tab exists). Fires from
`server.js`'s child-close handler only when `gen.subscribers.size === 0` at that moment.

## Secure input (never through plain chat)
`request_secure_input`/`check_secure_input` MCP tools (in the shared `gui` server) let an
agent ask the user for a sensitive value (password, API key, OTP) without it ever appearing
in chat text, the conversation transcript, or `sessions.json`. Flow: the tool POSTs to
`/internal/secure-input/create` (localhost-only, gated by `INTERNAL_SHARED_SECRET` shared
between `server.js` and the MCP server's env) → `server.js` broadcasts a `secure_input_request`
SSE event to whichever conversation(s) are actively generating → the frontend shows a
dedicated modal (masked input, clearly separate from the chat bubble UI) → the user submits
via `/api/secure-input/:id/submit` (normal session-authenticated) → the value sits in memory
only, retrievable exactly once via polling, then is deleted. The MCP tool then types it
directly into whatever's currently focused on the virtual desktop via the same `xdotool`
mechanism as `type_text`. Design constraint learned the hard way: **the tool call must
return quickly** (a short bounded poll, ~8s) rather than blocking for the whole 5-minute
request lifetime — long-blocking tool calls do not reliably survive this environment's
between-turn process lifecycle, so `request_secure_input` returns a pending id you re-check
later with `check_secure_input` if the user hasn't submitted yet.

## Graceful restart
`restart_agent_app` MCP tool (same shared `gui` server) — prefer this over
`sudo systemctl restart agent-app` directly. It only sets an in-memory flag via
`POST /internal/restart/request`; the actual `systemctl restart` is deferred until *inside*
a generation's own child-close handler, i.e. only once that turn's response has fully
broadcast to every subscriber and every connection has ended. Safe to call at any point in a
turn, not just as the very last action — unlike calling `systemctl restart` directly, which
kills the very connection streaming the current reply mid-sentence. (One inherent
exception: deploying a change to the restart mechanism itself, or to `server.js` before this
tool's own backend route exists yet, still needs the old manual approach once.)

## Google SSO
Alongside the password login, not replacing it. `GET /api/auth/google` → Google OAuth
consent → `GET /api/auth/google/callback` verifies the returned email against
`ALLOWED_GOOGLE_EMAIL` (single-user allowlist — without this check, *any* Google account
could sign in once the OAuth consent screen leaves "Testing" mode) and sets the same
session flag as password login. `req.session.authMethod`/`googleEmail` track which path was
used, surfaced in Settings.

## Systemd services
`agent-app` (this backend, port 3000) · `xvfb` (virtual framebuffer, display `:99`) ·
`xfce` (desktop session) · `x11vnc` (VNC server) · `novnc` (websockify bridge, port 6080).
Restarting `agent-app` drops the current session's connection unless done via the graceful
`restart_agent_app` tool (above).

## GUI automation gotchas (learned from direct experience, not docs)
- Launching a GUI app via `sudo systemd-run --scope -- ...` ties its lifetime to the calling
  session; it reliably dies when the current turn ends (observed repeatedly with Chromium).
  Use a real transient **service** instead: `sudo systemd-run --unit=<name> -- ...` (no
  `--scope`) — it survives turn boundaries and shows up in `systemctl status <name>`.
- Chromium specifically (snap package) needs to run as **root** in this environment or its
  snap-cgroup validation fails (`is not a snap cgroup for tag snap.chromium.chromium`);
  `--uid=1000` breaks it. Non-snap GUI apps (e.g. `xfce4-terminal`) run fine as the normal
  `personalagent` user (`--uid=1000 --gid=1000`) and should default to that instead of root.
- Stop/clean up these transient login/admin-task services once done with them
  (`sudo systemctl stop <name>`) — they're one-off tools, not part of the permanent stack.
- For any credential a browser reveals only via clipboard-copy button, read it back with
  `DISPLAY=:99 xclip -selection clipboard -o` rather than transcribing it off a screenshot —
  visually-similar characters (e.g. `I` vs `l`) are a real, silent failure mode.

## Reverse proxy
Caddy (`/etc/caddy/Caddyfile`), host `personal-agent.duckdns.org`:
- `/` → `127.0.0.1:3000` (the Express app)
- `/desktop*` → `127.0.0.1:6080` (noVNC), gated by `forward_auth` against
  `127.0.0.1:3000/api/authcheck` — same session cookie protects both routes.
- `/desktop` (bare) redirects into `vnc.html?autoconnect=true&resize=scale&path=desktop/websockify`.

## Frontend notes
- Vanilla JS PWA: installable (manifest.json, sw.js), no build step, no framework.
- Live Desktop panel: on demand, creates an `<iframe src="/desktop/vnc.html?...">` so the
  user can watch the agent drive the GUI live; iframe is torn down (not just hidden) on
  close to kill the underlying VNC/websocket connection.
- Model-picker pill above the composer, and the Settings modal's CLI-engine `<select>`, both
  write to `/api/app-settings` and re-render on change (`refreshModelPicker()`).
- Secure-input modal (`#secure-input-modal`) and Settings modal (`#settings-modal`) are
  separate overlays from the normal chat bubble flow, deliberately so a security-sensitive
  prompt is never visually confusable with an ordinary assistant message.
- Voice input via the Web Speech API (`SpeechRecognition`/`webkitSpeechRecognition`).
- Enter inserts a newline in the composer (textarea default); **Ctrl/Cmd+Enter** sends.
- SSE consumption uses a manually-managed `fetch` + abort controller
  (`currentEventSourceAbort`), not the native `EventSource` (needed because it's a POST with
  a JSON body, which `EventSource` can't send). Reattach-on-reconnect (`tryReattach`) hits
  `GET /api/chat/attach?conversationId=` which replays a `sync` snapshot of everything that
  happened before reconnecting, then continues streaming live.

## Auth
Password (`AGENT_PASSWORD_HASH` env var, `salt:hash` scrypt, `timingSafeEqual` compare) or
Google SSO (above) — either sets the same session flag. Session cookie via `express-session`
(`SESSION_SECRET` env var), `httpOnly`, `secure`, `sameSite: lax`, 30-day maxAge. Password
login is rate-limited per IP (10 attempts / 15 min). Do not weaken or bypass either auth
path, and never log or print `AGENT_PASSWORD_HASH` / `SESSION_SECRET` / `GOOGLE_CLIENT_SECRET`
/ `INTERNAL_SHARED_SECRET` / `VAPID_PRIVATE_KEY` / any CLI's OAuth token.

## Ground rules for self-modification (also in IMPROVE_SYSTEM_PROMPT)
- This app is the user's only interface to this machine — never leave it broken.
  `node -c` (or equivalent) any edited JS before restarting `agent-app`.
- Prefer small, testable changes over big rewrites.
- Never remove/weaken login/session auth (either path); never expose secrets.
- Prefer the `restart_agent_app` tool over a raw `systemctl restart` (see above), and report
  what changed and why regardless of which mechanism is used.
- For destructive/irreversible/security-touching changes, explain the tradeoff rather than
  assuming consent — this includes things like installing new software, creating credentials
  in a third-party account, or granting broad filesystem trust to a new CLI tool.
