---
name: intent-shaping
description: Extracts the real business outcome when the user has a vague direction or jumps to tactics before the goal is clear. Activate when triggered by CF-01 from the release-decision framework, or when user says "I want to improve X", "we should add Y", "increase adoption", "make it better", or describes a tactic without stating a goal. Do not use when the goal is already measurable and specific.
license: Apache-2.0
metadata:
  author: FeatBit
  version: "1.1.0"
  category: release-management
---

# Intent Shaping

This skill handles **CF-01: Intent Clarification** from the release-decision framework.

Its job is to extract a real, measurable business outcome from a vague or tactic-first statement before any hypothesis, implementation, or measurement work begins.

## When to Activate

- User describes a desire without a measurable outcome ("we want more engagement")
- User names a solution before naming the problem ("we should add a better CTA")
- User mixes goal and implementation ("improve the onboarding flow so users see the feature")
- `goal` field is empty or vague

## On Entry — Read Current State

Use the `project-sync` skill's `get-experiment` command to load the current project state from the database. Check:

- `goal` and `intent` — are they already filled from a previous cycle? If so, confirm with the user whether to refine or start fresh.
- `lastLearning` — was there a prior cycle? Use it as context for the new intent.
- `stage` — if already past `intent`, confirm the user wants to revisit.

This read is required. Do not rely on conversation memory alone — the database is the canonical source.

## Core Principle

Separate **what we want to happen in the world** from **what we plan to build**.

A goal is a desired change in user behavior or a business metric. A solution is one possible path to that goal. Neither can stand in for the other.

## Decision Actions

### Tactic-first detection

If the user leads with a solution, ask what outcome that solution is meant to produce.

> "If that [tactic] works exactly as intended, what would you expect to see change — and for whom?"

### Outcome extraction

Once a direction exists, sharpen it into a measurable form:

- What specific behavior or metric should change?
- For which audience?
- From what baseline?

### Scope check

Confirm the goal belongs to this iteration — not a 6-month vision.

## Operating Rules

- Ask one question at a time
- Never proceed to hypothesis or implementation until goal is measurable
- Hand off to `hypothesis-design` once the goal is sharp

### Persist State

Use `Skill("project-sync", ...)` to sync state to the web database. All three writes are required:

```python
assert Skill("project-sync", f'update-state {experiment_id} --goal "..." --intent "..." --lastAction "Intent clarified"').ok
assert Skill("project-sync", f"set-stage {experiment_id} intent").ok
assert Skill("project-sync", f'add-activity {experiment_id} --type stage_update --title "Intent clarified"').ok
```

**Terminology note:** `goal` and `intent` overlap intentionally. `goal` = the measurable business outcome. `intent` = what the user said they wanted to improve or learn (may still be broad). Both are written at this stage.

## Execution Procedure

```python
def shape_intent(project_id, user_message):
    state = Skill("project-sync", f"get-experiment {project_id}")
    if not is_blank_intent(state) and not user_wants_reset(user_message):
        # goal and intent already set — hand off rather than overwrite
        Skill("hypothesis-design", project_id)
        return
    patterns = read("references/goal-extraction-patterns.md")
    # extraction loop: ask one question at a time until goal is measurable
    # tactic-first → ask "if that tactic works, what changes for whom?"
    # vague-improvement → ask "what specific behavior or metric should change?"
    # scope check → confirm this is an iteration goal, not a 6-month vision
    goal = extract_goal(user_message, patterns)
    intent = user_message  # preserve the original phrasing
    assert Skill("project-sync", f'update-state {project_id} --goal "{goal}" --intent "{intent}" --lastAction "Intent clarified"').ok
    assert Skill("project-sync", f"set-stage {project_id} intent").ok
    assert Skill("project-sync", f'add-activity {project_id} --type stage_update --title "Intent clarified"').ok
    Skill("hypothesis-design", project_id)
```

## Signal Inference

| Entry shape | How to handle |
|---|---|
| Tactic-first ("add a better CTA") | Ask what outcome that tactic is meant to produce |
| Vague-improvement ("more engagement") | Ask which specific behavior or metric should change, and for whom |
| Resumed cycle with `lastLearning` | Use the prior learning as framing for the new intent question |
| `goal` already measurable | Skip extraction; hand off to `hypothesis-design` immediately |
| Scope too broad (6-month vision) | Ask which part of the vision applies to the next 2–4 week iteration |

Measurability check: a goal is measurable when you can say "we'll know it worked when [specific metric] [moves in direction] by [any amount]".

## Reference Files

- [references/goal-extraction-patterns.md](references/goal-extraction-patterns.md) — question sequences, vague→clear examples, common anti-patterns
