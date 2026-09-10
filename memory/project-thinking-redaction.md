---
name: project-thinking-redaction
description: Claude CLI never returns real extended-thinking text in -p/stream-json mode
metadata:
  type: project
---

The `claude` CLI, when invoked the way `server.js` does (`-p ... --output-format stream-json`,
which is how every agent-app request is made), always returns `thinking` content blocks with
`"thinking": ""` (empty) and only an opaque `signature` field populated — verified across 103 real
thinking blocks in on-disk session transcripts, including freshly generated ones, and with
`--verbose` already on. There is no CLI flag that unlocks real reasoning text in this mode.

**Why**: this is an Anthropic-side redaction for programmatic/`-p` consumption (any third-party
app using this invocation style hits the same wall, not just this one), not a bug in this app's
SSE plumbing or frontend.

**How to apply**: don't re-investigate "why is the thinking box empty" as a bug — the fix already
applied is a static "Used extended thinking" placeholder/checkmark instead of trying to render
real content. If a future request wants genuine visible reasoning, the only path is switching the
invocation away from `-p`/stream-json mode entirely (interactive `claude` session), which is a
much bigger architecture change.
