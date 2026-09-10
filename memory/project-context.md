---
name: project-context
description: What Personal Agent is and its goal
metadata:
  type: project
---

Personal Agent is jadeed@systalent.com's personal AI agent, self-hosted on their own Azure VM
(`test-agent`, `20.44.52.130`). The goal: prompt the agent from a phone or any browser and have it
do real work on that machine — files, shell, GUI apps, its own desktop — not just chat.

**Why**: full autonomy and ownership. Everything runs on hardware the user controls, with no
third-party agent-hosting dependency.

**How to apply**: default to giving the agent real capability (shell, GUI, self-modification) over
sandboxing it — the user has consistently chosen more autonomy, not less, at every step of this
build (Improve mode, GUI control, multi-provider). Security constraints that exist (secure-input
flow, single allow-listed login, never auto-entering credentials) are deliberate exceptions, not a
general instinct toward caution.
