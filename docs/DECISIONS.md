# Decisions

Dated entries for choices worth remembering the *why* of, not just the *what*.

## 2026-09-10 — Every provider's child process explicitly closes stdin
**What**: `spawn(provider.command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })` instead
of leaving `stdio` unspecified.
**Why**: found while adding the Codex provider — `codex exec` checks whether stdin is piped and
blocks reading it to EOF *before emitting anything*, not even `thread.started`. Node's default
stdio is an open pipe that's never written to and never closed, so it never sends EOF, so the
child hung forever with zero output — confirmed directly by spawning `codex exec` both ways.
Closing stdin explicitly fixes it and is harmless for Claude/Antigravity, which don't read stdin.

## 2026-09-10 — Codex CLI installed and MCP-registered, but not logged in
**What**: `codex` installed to `~/.local/bin` (npm global install needs a writable prefix; the
system one under `/usr` isn't), all four MCP servers registered via `codex mcp add`, the
`PROVIDERS.codex` entry wired into `server.js` and the model catalog/Settings dropdown updated —
but no `codex login` or `CODEX_API_KEY` was set up.
**Why**: authentication is a credential/consent decision (which OpenAI account, subscription vs.
pay-per-token API billing) that belongs to the user, same reasoning as why Antigravity's Google
OAuth was always done interactively via Live Desktop rather than automated. Selecting "Codex CLI"
in Settings today will spawn the process correctly and surface a clean 401 as a chat error — not a
hang — until that login step happens.

## 2026-09-10 — Provider-agnostic persistent memory, injected upstream of the provider abstraction
**What**: `docs/` (app self-knowledge) and `memory/` (user/project knowledge) as plain markdown,
read from disk and prepended to `fullPrompt` unconditionally, before any provider's `buildArgs()`
runs.
**Why**: Claude Code's own auto-memory is per-project and invisible to any other CLI; a memory
system that's supposed to survive switching between Claude/Antigravity/(future Codex) can't live
inside one CLI's proprietary format. Doing the injection in one place, upstream of the provider
abstraction, means adding a new provider later costs nothing extra for memory to keep working.
**Rejected**: a RAG/vector-store layer — the corpus (a handful of docs) is far too small for
retrieval infrastructure to pay for itself; direct read is both simpler and faster at this scale.

## 2026-09-10 — Attachment paths are absolute, not workspace-relative
**What**: `/api/chat/stream` now tells the agent the absolute path of an uploaded attachment.
**Why**: uploads always land under `~/workspace/uploads`, but Improve-mode conversations run with
cwd `~/agent-app` — a workspace-relative path silently failed to resolve there. Found while
building the "Create Design" feature (uploads a reference photo into an Improve-mode conversation).

## Secure input never returns the typed value to the model
**What**: `request_secure_input`/`check_secure_input` type the value directly into the focused
desktop field via `xdotool` and return only a status string ("entered" / "cancelled") — never the
value itself.
**Why**: hard rule — the agent must never see, log, or transcript a password/OTP, even though it's
the one asking for it and the one that benefits from it being entered. This is what makes it safe
to let the agent drive a login flow (e.g. GlobalProtect) right up to the credential field.

## Service worker: network-first, not cache-first, with an auto-reload nudge
**What**: `sw.js` tries the network first and only falls back to cache when offline; on activation
it posts a message to open tabs, which triggers a reload if nothing is mid-stream.
**Why**: a cache-first strategy meant deployed frontend changes didn't reach already-open clients
until a hard refresh — found repeatedly while shipping UI changes mid-session.

## Always re-diff live files before deploying, never trust a locally-cached "current" copy
**What**: before overwriting `server.js`/`app.js`/`index.html`/`styles.css` on the VM, re-pull the
live copy and diff it against what's about to be deployed.
**Why**: a live Improve-mode session can add real features (e.g. the music player, the WhatsApp
bridge) between one pull and the next deploy. A blind overwrite from a stale local copy nearly
erased a shipped feature. Take a timestamped backup under `~/agent-app/.backups/` before any risky
deploy, too.
