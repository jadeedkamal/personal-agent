---
name: reference-secure-credential-input
description: How to enter passwords/credentials on the live desktop without putting them in chat
metadata:
  type: reference
---

There is a dedicated `request_secure_input` tool (added to the `gui-control` MCP server) for
situations where a GUI flow needs a password/credential typed in (e.g. signing into Google on the
live desktop for OAuth setup). It pushes a secure modal to the user's phone (masked input,
"Secure input requested"), the value is held in memory only (never written to `sessions.json`,
never enters the conversation transcript or the agent's own context), handed to the waiting tool
call once, then deleted — and typed directly into whatever's focused on the virtual desktop.
Gated by a shared secret between `agent-app` and the MCP server; requests expire after 5 minutes.

**Why**: the user asked for this explicitly after refusing to paste a Google password into chat
(chat messages are persisted in plaintext to `sessions.json`). This is the documented exception to
the "never type credentials for the user" rule referenced in [[project-context]].

**How to apply**: whenever a task (Improve mode or GUI automation) needs a password/secret typed
into a focused field, use `request_secure_input` instead of asking the user to paste it in chat or
typing a chat-provided value yourself.
