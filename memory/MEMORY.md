# Memory index

One line per note. Read the linked file for detail.

- [project-context.md](project-context.md) — what this project is and its goal.
- [user-preferences.md](user-preferences.md) — how the user likes to collaborate on this app.
- [feedback-deploy-safety.md](feedback-deploy-safety.md) — re-diff live files before deploying; confirmed cause: a concurrent VS Code/Copilot session can clobber them.
- [reference-services.md](reference-services.md) — SSH/domain/service quick reference, incl. Google SSO config and Chromium turn-lifecycle note.
- [feedback-restart-timing.md](feedback-restart-timing.md) — don't restart agent-app mid-stream; finish the response first.
- [reference-secure-credential-input.md](reference-secure-credential-input.md) — use `request_secure_input` tool for passwords, never chat.
- [project-thinking-redaction.md](project-thinking-redaction.md) — claude CLI's -p/stream-json mode never returns real thinking text; not fixable in our code.
