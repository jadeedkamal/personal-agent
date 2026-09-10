---
name: feedback-deploy-safety
description: Always re-diff live files before deploying, never trust a stale local copy
metadata:
  type: feedback
---

Before overwriting `server.js`, `app.js`, `index.html`, or `styles.css` on the VM, re-pull the
live copy and diff it against what's about to be deployed — don't assume a locally-held "current"
copy is still current.

**Why**: the user caught this directly — an earlier deploy was about to blindly overwrite the
live app.js/index.html with a local copy taken before an Improve-mode session had added a whole
music feature (a new button, modal, and backend endpoints). That would have silently erased it.

**How to apply**: this rule applies any time meaningful time has passed since the file was last
read, or any time a different session/Improve-mode conversation could plausibly have touched the
same files — which in this app is often, since Improve mode is a normal, frequently-used way of
changing the app. Take a timestamped backup under `~/agent-app/.backups/` before a deploy that
touches more than a trivial line, too.

**Confirmed real-world cause**: this has actually happened — a VS Code + GitHub Copilot Chat
session was open on the live desktop, editing `index.html`/`app.js`/`styles.css` at the same time
an Improve-mode conversation was, and it silently overwrote the in-progress theme-picker changes
(classic lost-update race, no file locks). If a just-built static-frontend feature "disappears" or
reverts partway through a session, check for another live editor process (`ps aux | grep -i code`)
before assuming caching or a bug — and close it before continuing, since two writers on the same
unlocked files will keep racing.

