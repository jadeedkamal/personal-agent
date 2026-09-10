# Features

- Password + Google SSO login (single allow-listed account), session-cookie auth throughout.
- Streaming chat with a live tool-activity feed (collapsible, shows each tool call as it runs).
- Markdown + syntax-highlighted code rendering in assistant replies.
- Conversation history sidebar — search, rename, delete, per-conversation mode badge.
- File/image upload as chat attachments; a separate general file manager (list/upload/download/delete).
- Voice input (Web Speech API) and a cancel button for in-flight responses.
- Installable PWA (manifest + service worker), auto-updates connected clients on redeploy.
- Two conversation modes: workspace (general use) and Improve (agent edits/redeploys its own app).
- Multi-provider chat: switch between Claude Code, Antigravity (Gemini 3.x), and Codex CLI (GPT-5.x
  Codex) per conversation; switching mid-conversation carries prior context forward manually since
  native session resume is provider-specific. (Codex is wired up in code but not yet logged in on
  this machine — see ARCHITECTURE.md.)
- Virtual desktop the agent can see and operate (mouse/keyboard/screenshots/launch apps), viewable
  live in the browser at any time, and embeddable directly above any chat ("Live Desktop").
- Secure-input modal — the one sanctioned way the agent gets a password/OTP into a field, without
  the value ever entering chat, model context, or disk.
- Theme system: five base palettes (Dark/Light/Midnight/Forest/Sunset) plus three fully custom,
  hand-designed themes (Skeuomorphic, Neo-brutalism, Claymorphism), plus **Create Design** —
  upload a reference photo and the agent designs, builds, and deploys a brand-new matching theme
  end-to-end.
- WhatsApp bridge (linked-device session, allow-listed numbers) as a second way to reach the agent.
- Music: paste a link, download, browse, and play from the app.
- Push notifications when a response finishes.
- Persistent memory: `docs/` (what the app is) and `memory/` (what's known about the user/project),
  both provider-agnostic and injected into every conversation automatically.
