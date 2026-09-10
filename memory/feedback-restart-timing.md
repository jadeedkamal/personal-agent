---
name: feedback-restart-timing
description: Don't restart agent-app while a response is still streaming to the user
metadata:
  type: feedback
---

When a backend change (`server.js`) needs a restart to take effect, don't restart abruptly while
a response is still generating/streaming — that kills the user's connection mid-reply and shows a
"Network error" in the UI. Let the current response finish, then tell the user it's ready and ask
them to trigger the restart (or restart right after the response completes).

**Why**: the user explicitly flagged this — an abrupt restart during an active turn produced a
network error instead of a clean completion, which reads as a crash rather than a deploy.

**How to apply**: in Improve mode, after finishing a backend edit, check whether the current
conversation (or any conversation) has a generation in flight before restarting. If one is
active, wait for it to close out first, or explicitly tell the user "ready to restart, will do
it after this response" rather than restarting immediately mid-stream.
