---
name: hypothesis-design
description: Converts a clear business goal into a falsifiable hypothesis before implementation begins. Activate when triggered by CF-02 from the release-decision framework, or when a goal exists but there is no explicit causal claim linking a change to an expected outcome. Triggers — "write a hypothesis", "what do we expect", "what should we test", "we think this will work because". Do not use when the hypothesis is already sharp and falsifiable.
license: Apache-2.0
metadata:
  author: FeatBit
  version: "1.1.0"
  category: release-management
---

# Hypothesis Design

This skill handles **CF-02: Hypothesis Discipline** from the release-decision framework.

Its job is to convert a goal into a testable, falsifiable statement before any implementation or measurement work begins.

## When to Activate

- Goal exists but no causal claim links the change to the outcome
- User says "we think this will help" without explaining the mechanism
- `hypothesis` field is empty or non-falsifiable
- User is about to build without stating what they expect

## On Entry — Read Current State

Use the `project-sync` skill's `get-experiment` command to load the current project state from the database. Check:

- `goal` and `intent` — were they set by `intent-shaping`? If empty, go back to `intent-shaping` first.
- `hypothesis`, `change`, `variants`, `primaryMetric` — are they already filled? If so, verify with the user whether to refine or start fresh.
- `stage` — confirms where the project is in the loop.

This read is required. Do not rely on conversation memory alone — the database is the canonical source.

## Core Template

> We believe **[change X]** will **[move metric Y in direction Z]** for **[audience A]**, because **[causal reason R]**.

Every component is required. A hypothesis without a causal reason is a hope, not a testable claim.

## Validation Questions

Check each component:

1. **Change X** — Is this specific enough to implement? Could two engineers build the same thing from this description?
2. **Metric Y** — Is this measurable? Does instrumentation exist or can it be built?
3. **Direction Z** — Is the direction stated (increase / decrease / maintain)?
4. **Audience A** — Is the target audience specific enough to be segmented in analysis?
5. **Reason R** — Is the causal mechanism explicit? "Because users will like it" is not a reason.

## Decision Actions

### Draft the hypothesis

Work with the user to fill all five components. Ask about missing parts one at a time.

### Test for falsifiability

Ask: "Under what conditions would we conclude this hypothesis was wrong?" If the answer is "none", it is not falsifiable.

### Sharpen the metric claim

The hypothesis does not need a specific number at this stage. It needs a direction. Quantitative targets belong in the evaluation plan, not the hypothesis.

## Operating Rules

- Do not proceed to implementation planning until all five components are present
- Do not conflate the hypothesis with the success threshold (that belongs in `evidence-analysis`)
- Hand off to `reversible-exposure-control` once hypothesis is confirmed

### Persist State

Use `Skill("project-sync", ...)` to sync state to the web database. All three writes are required:

```python
assert Skill("project-sync", f'update-state {experiment_id} --hypothesis "We believe [change] will [move metric] for [audience] because [reason]" --change "[specific change]" --variants "[control (annotation)|treatment (annotation)]" --primaryMetric "[metric name] — [rationale]" --lastAction "Hypothesis formed"').ok
assert Skill("project-sync", f"set-stage {experiment_id} hypothesis").ok
assert Skill("project-sync", f'add-activity {experiment_id} --type stage_update --title "Hypothesis formed"').ok
```

## Execution Procedure

```python
def design_hypothesis(project_id, user_message):
    state = Skill("project-sync", f"get-experiment {project_id}")
    if state.goal in ("", None):
        Skill("intent-shaping", project_id)
        return
    template = read("references/hypothesis-template.md")
    # fill all 5 components: change, metric, direction, audience, causal reason
    # ask about missing parts one at a time
    # falsifiability check: "under what conditions would we conclude this was wrong?"
    hypothesis = build_hypothesis(state.goal, template, user_message)
    assert Skill("project-sync", f'update-state {project_id} --hypothesis "{hypothesis.text}" --change "{hypothesis.change}" --variants "{hypothesis.control} (control)|{hypothesis.treatment} (treatment)" --primaryMetric "{hypothesis.metric} — {hypothesis.metric_rationale}" --lastAction "Hypothesis formed"').ok
    assert Skill("project-sync", f"set-stage {project_id} hypothesis").ok
    assert Skill("project-sync", f'add-activity {project_id} --type stage_update --title "Hypothesis formed"').ok
    Skill("reversible-exposure-control", project_id)
```

## Signal Inference

| Check | Rule |
|---|---|
| `goal` empty | Redirect to `intent-shaping` before doing any hypothesis work |
| `hypothesis` already exists | Verify with user: refine or keep? Do not overwrite without confirmation |
| Component missing: change | Ask "What specifically will be built or changed?" |
| Component missing: causal reason | Ask "Why do you expect that change to move the metric?" |
| Falsifiability fails | Ask "Under what conditions would you conclude the hypothesis was wrong?" |
| Metric implied but unnamed | Name it explicitly — do not allow "some engagement metric" to pass |

## Reference Files

- [references/hypothesis-template.md](references/hypothesis-template.md) — full template, good/bad examples, falsifiability check, what belongs here vs. in evidence-analysis
