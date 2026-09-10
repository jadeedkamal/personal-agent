---
name: user-preferences
description: How the user likes to collaborate on this app
metadata:
  type: user
---

Cares about genuinely distinctive, non-generic visual design — explicitly rejected the idea of
just re-skinning colors and asked for real material/craft differences between themes (skeuomorphic
vs neo-brutalism), following the frontend-design skill's guidance against AI-slop defaults.

**Why**: said the UI was "really bad" even with 5 working color themes already in place — the
complaint was about visual craft, not missing features.

**How to apply**: when building or extending UI, favor a genuine design pass (token system, ground
it in real subject matter, self-critique against generic-AI-design tells) over reusing an existing
component's look-and-feel by default.

---

Wants the ability to move between underlying CLIs/models (Claude Code, Antigravity/Gemini, and
future ones like Codex) without losing continuity — asked twice about cross-CLI portability
specifically for memory.

**How to apply**: when adding any new persistent capability, put it upstream of the provider
abstraction in `server.js` (same pattern as the memory system) rather than inside one provider's
code path, unless it's genuinely provider-specific.
