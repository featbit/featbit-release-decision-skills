---
name: learning-capture
description: Captures structured learnings at the end of an experiment or release cycle so the next iteration starts from evidence rather than memory. Activate when triggered by CF-08 from the release-decision framework, or when user says "what did we learn", "close this experiment", "we're done with this cycle", "next iteration", "this experiment is over", "capture learning". Activate immediately after a decision is made in evidence-analysis.
license: Apache-2.0
metadata:
  author: FeatBit
  version: "1.1.0"
  category: release-management
---

# Learning Capture

This skill handles **CF-08: Learning Closure** from the release-decision framework.

Its job is to produce a reusable learning at the end of every cycle — good, bad, or inconclusive — so the next iteration does not start from opinion.

## When to Activate

- A decision has been made (CONTINUE, PAUSE, ROLLBACK CANDIDATE, or INCONCLUSIVE)
- The experiment window has closed
- The user says "what did we learn" or "next iteration"
- Project stage is `deciding` and a decision exists

## On Entry — Read Current State

Before doing any work, read the project from the database using the `project-sync` skill's `get-experiment` command.

Check these fields:

| Field | Purpose |
|---|---|
| `hypothesis` | The claim that was tested |
| `primaryMetric` | What was measured |
| `stage` | Current lifecycle position |
| `experiments` | Experiment records with decision data |
| `lastLearning` | Previous learning (if iterating) |

- If no experiment has a `decision` field → redirect to `evidence-analysis` first
- If `stage` is not `deciding` → a decision may not have been made yet
- If `lastLearning` already contains a learning for this cycle → review rather than recreate

## What a Complete Learning Contains

1. **What changed** — the specific change that was tested (not "improved the UI")
2. **What happened** — the measured outcome with numbers
3. **Confirmed or refuted** — was the hypothesis directionally correct?
4. **Why it likely happened** — the causal interpretation (honest about uncertainty)
5. **Next hypothesis** — what this result suggests to try next

All five are required. A learning missing (4) or (5) does not close the loop.

## Decision Actions

### Produce the learning

Work through each of the five components with the user. Prompt for missing parts one at a time.

### Write to decision context

Use the `project-sync` skill to persist the learning to the database (see Persist State below).

### Surface the next hypothesis

The learning must always end with a directional suggestion for what to test next. This is not a commitment — it is the input to the next `intent-shaping` + `hypothesis-design` cycle.

## Operating Rules

- Do not allow a cycle to close without a written learning
- INCONCLUSIVE cycles still produce learnings — "we learned this measurement approach was inadequate" is valid and complete
- Do not let the learning become a post-mortem — it is forward-facing input
- For longer cycles, write a fuller document to `artifacts/learning-[date].md`
- Hand off to `intent-shaping` for the next cycle
- **Do NOT change `Experiment.status` here.** It remains `decided` (set by `experiment-workspace` when closing) or `archived` if explicitly archiving. Never set it to `"completed"`, `"finished"`, or any other value.

### Persist State

Use `Skill("project-sync", ...)` to sync state. All five writes are required:

```python
assert Skill("project-sync", f'update-state {experiment_id} --lastLearning "{summary}" --lastAction "Learning captured"').ok
assert Skill("project-sync", f"set-stage {experiment_id} learning").ok
assert Skill("project-sync", f'save-learning {experiment_id} {slug} --whatChanged "{what_changed}" --whatHappened "{what_happened}" --confirmedOrRefuted "{confirmed_or_refuted}" --whyItHappened "{why}" --nextHypothesis "{next_hypothesis}"').ok
assert Skill("project-sync", f"archive-run {experiment_id} {slug}").ok
assert Skill("project-sync", f'add-activity {experiment_id} --type learning_captured --title "Learning captured"').ok
```

## Execution Procedure

```python
def capture_learning(project_id, user_message):
    state = Skill("project-sync", f"get-experiment {project_id}")
    active_run = pick_active_run(state)   # run in decided status
    if active_run is None or active_run.decision is None:
        Skill("evidence-analysis", project_id)
        return
    template = read("references/iteration-synthesis-template.md")
    # 5-part synthesis loop — ask about missing parts one at a time
    learning = build_learning(active_run, state, template, user_message)
    # INCONCLUSIVE cycles still require whyItHappened + nextHypothesis:
    # "we learned this measurement approach was inadequate" is valid and complete
    assert Skill("project-sync", f'update-state {project_id} --lastLearning "{learning.summary}" --lastAction "Learning captured"').ok
    assert Skill("project-sync", f"set-stage {project_id} learning").ok
    assert Skill("project-sync", f'save-learning {project_id} {active_run.slug} --whatChanged "{learning.what_changed}" --whatHappened "{learning.what_happened}" --confirmedOrRefuted "{learning.confirmed_or_refuted}" --whyItHappened "{learning.why}" --nextHypothesis "{learning.next_hypothesis}"').ok
    assert Skill("project-sync", f"archive-run {project_id} {active_run.slug}").ok
    assert Skill("project-sync", f'add-activity {project_id} --type learning_captured --title "Learning captured"').ok
    Skill("intent-shaping", project_id)
```

## Signal Inference

| Check | Rule |
|---|---|
| No run with `decision` set | Redirect to `evidence-analysis` |
| INCONCLUSIVE result | Still complete all 5 learning components — uncertainty is a valid learning |
| Component (4) missing (`whyItHappened`) | Push back — causal interpretation required even if honest uncertainty |
| Component (5) missing (`nextHypothesis`) | Push back — loop does not close without a forward-facing suggestion |
| `lastLearning` already contains this cycle | Review rather than recreate — ask user if updating or closing a different run |

## Reference Files

- [references/iteration-synthesis-template.md](references/iteration-synthesis-template.md) — full five-part template, confirmed/refuted/inconclusive examples, anti-patterns
