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

Call `featbit_release_decision_get_experiment` through the configured FeatBit experimentation MCP server to load the current experiment state. Check:

- `goal` and `intent` — were they set by `intent-shaping`? If empty, go back to `intent-shaping` first.
- `hypothesis`, `change`, `variants` — are they already filled? If so, verify with the user whether to refine or start fresh.
- `primaryMetric` — if already present, verify whether it is a complete metric contract from `measurement-design`; do not create or overwrite it here.
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

### Sharpen the metric direction

The hypothesis does not need a specific number at this stage. It needs a direction. Quantitative targets belong in the evaluation plan, not the hypothesis.

Do not persist a primary metric from this skill. A usable FeatBit primary metric requires `metricName`, `metricEvent`, `metricType`, and `metricAgg`, and must be written later through `featbit_release_decision_update_metrics` during measurement design.

## Operating Rules

- Do not proceed to implementation planning until all five components are present
- Do not conflate the hypothesis with the success threshold (that belongs in `evidence-analysis`)
- Do not call `featbit_release_decision_update_experiment` with `primaryMetric`
- Hand off to `reversible-exposure-control` once hypothesis is confirmed

### Persist State

Use FeatBit experimentation MCP tools to sync state. Both writes are required:

```python
MCP("featbit_release_decision_update_experiment", experimentId=experiment_id, update={
    "hypothesis": "We believe [change] will [move metric] for [audience] because [reason]",
    "change": "[specific change]",
    "variants": "[control (annotation)|treatment (annotation)]",
    "lastAction": "Hypothesis formed",
})
MCP("featbit_release_decision_set_stage", experimentId=experiment_id, stage="hypothesis")
```

## Execution Procedure

```python
def design_hypothesis(experiment_id, user_message):
    state = MCP("featbit_release_decision_get_experiment", experimentId=experiment_id)
    if state.goal in ("", None):
        Skill("intent-shaping", experiment_id)
        return
    template = read("references/hypothesis-template.md")
    # fill all 5 components: change, metric, direction, audience, causal reason
    # ask about missing parts one at a time
    # falsifiability check: "under what conditions would we conclude this was wrong?"
    hypothesis = build_hypothesis(state.goal, template, user_message)
    MCP("featbit_release_decision_update_experiment", experimentId=experiment_id, update={
        "hypothesis": hypothesis.text,
        "change": hypothesis.change,
        "variants": f"{hypothesis.control} (control)|{hypothesis.treatment} (treatment)",
        "lastAction": "Hypothesis formed",
    })
    MCP("featbit_release_decision_set_stage", experimentId=experiment_id, stage="hypothesis")
    Skill("reversible-exposure-control", experiment_id)
```

## Signal Inference

| Check | Rule |
|---|---|
| `goal` empty | Redirect to `intent-shaping` before doing any hypothesis work |
| `hypothesis` already exists | Verify with user: refine or keep? Do not overwrite without confirmation |
| Component missing: change | Ask "What specifically will be built or changed?" |
| Component missing: causal reason | Ask "Why do you expect that change to move the metric?" |
| Falsifiability fails | Ask "Under what conditions would you conclude the hypothesis was wrong?" |
| Metric implied but unnamed | Name the metric direction inside the hypothesis; do not create `primaryMetric` here |

## Reference Files

- [references/hypothesis-template.md](references/hypothesis-template.md) — full template, good/bad examples, falsifiability check, what belongs here vs. in evidence-analysis
