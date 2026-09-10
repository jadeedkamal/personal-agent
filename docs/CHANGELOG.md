# Changelog

Dated, one-line-per-change-ish. Newest first.

## 2026-09-10
- Fixed: conversation list edit/delete buttons (`.row-actions`) were `opacity:0` until `:hover`,
  which never fires on touch devices — invisible and effectively untappable on mobile. Now shown
  at full opacity under `@media (hover: none)`, keeping the hover-reveal behavior on desktop.
- Added theme: Claymorphism (id `clay`) — warm cream soft-UI "clay" material (base/raised/inset/
  pressed layers, 4/8/12/16/24px radius scale) with a dark teal primary/status accent and amber
  warning accent, built via Create Design from a reference UI-foundations spec sheet photo.
- Added a third CLI engine: Codex CLI (OpenAI), alongside Claude Code and Antigravity. Installed
  user-local (`~/.local/bin/codex`, not on `$PATH`), MCP servers registered via `codex mcp add`
  pointing at the same server files as the other two engines. Not yet logged in — `codex login`
  (or `CODEX_API_KEY`) still needed before it's actually usable. Fixed a real hang along the way:
  Codex checks whether stdin is piped and blocks reading it before doing anything, so `spawn()`
  now explicitly closes the child's stdin (`stdio: ['ignore', 'pipe', 'pipe']`) for every provider
  — an unwritten default Node pipe never sends EOF, so it hung forever.
- Added persistent memory system: `docs/` + `memory/`, injected into every conversation for every
  provider (see DECISIONS.md).
- Fixed: attachment paths sent to the agent are now absolute, not workspace-relative (broke in
  Improve mode, whose cwd differs from where uploads live).
- Added "Create Design" — upload a reference photo, agent designs + builds + deploys a new theme
  end-to-end via an Improve-mode conversation.
- Added themes: Skeuomorphic ("Field Recorder" — brushed gunmetal + saddle leather + amber VFD)
  and Neo-brutalism (thick borders, hard offset shadows, flat saturated color).
- Fixed: `#design-studio-modal` had no backdrop/positioning CSS, so opening it appeared to do
  nothing.
- Sidebar footer cleanup: removed the "test-agent · IP" text label, evenly spaced the icon row,
  made the design-studio icon match the app's existing sparkle motif.
- Added "Live Desktop": the noVNC virtual-desktop stream embeds directly above any chat, with a
  compact/full-history toggle and screenshot-gallery suppression while it's open.
- Added multi-provider support: Antigravity (Gemini 3.x) alongside Claude Code, selectable per
  conversation, with manual context handoff on a mid-conversation provider switch.

## Earlier (this build-out, undated in detail)
- Initial app: VM provisioning, DuckDNS + Caddy HTTPS, password/session auth, streaming chat,
  tool-activity feed, markdown rendering, conversation history, file uploads, PWA shell.
- Virtual desktop stack (Xvfb/XFCE/x11vnc/noVNC) and the GUI-control MCP server.
- Secure-input flow for credential entry without the agent ever seeing the value.
- Improve mode (agent edits its own source, restarts its own services).
- WhatsApp bridge, music player, general file manager, push notifications, Google SSO.
- Service worker fixed from cache-first (stale deploys) to network-first with auto-reload.
