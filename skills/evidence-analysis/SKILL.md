---
name: evidence-analysis
description: Evaluates collected data to determine if evidence is sufficient to decide, then frames the outcome as CONTINUE, PAUSE, ROLLBACK CANDIDATE, or INCONCLUSIVE. Activate when triggered by CF-06 or CF-07 from the release-decision framework, or when user says "analyze results", "should I ship this", "continue or rollback", "is this significant", "what do the results say", "has it been long enough". Do not use when data collection has not started.
license: Apache-2.0
metadata:
  author: FeatBit
  version: "1.1.0"
  category: release-management
---

# Evidence Analysis

This skill handles **CF-06: Evidence Sufficiency** and **CF-07: Decision Framing** from the release-decision framework.

CF-06 and CF-07 are handled together because they represent a continuous decision: first determine if evidence is sufficient, then frame what the evidence says.

## When to Activate

- Data is being collected and the user wants to know whether to decide now
- The user is impatient to interpret weak or early evidence
- Results exist and a go/no-go decision is needed
- Project stage is `measuring` or `deciding`

## On Entry — Read Current State

Before doing any work, read the project from the database using the `project-sync` skill's `get-experiment` command.

Check these fields:

| Field | Purpose |
|---|---|
| `entryMode` | `"expert"` → user pre-filled setup + possibly data via the wizard; do not ask them to re-describe the experiment |
| `primaryMetric` | The metric that decides the outcome |
| `guardrails` | Metrics that must not degrade |
| `hypothesis` | The causal claim being tested (may be empty in expert mode — don't block on it) |
| `stage` | Current lifecycle position |
| `experimentRuns[*].inputData` | JSON observed-data snapshot pasted via the wizard, shape `{metrics:{event:{variant:{n,k}|{n,sum,sum_squares},inverse?}}}` |
| `experimentRuns[*].analysisResult` | Output of `runAnalysis` / `runBanditAnalysis`; may already exist |

- If `primaryMetric` is empty AND `entryMode !== "expert"` → redirect to `measurement-design`. In expert mode, the primary metric lives in `experimentRuns[*].primaryMetricEvent` even if the top-level `primaryMetric` text field is blank.
- If `stage` is `deciding` → a decision may already exist; check experiment records before re-analyzing
- If experiment records already have a `decision` field → may only need to review, not re-decide

### Pulling observed data

When `experimentRuns[*].inputData` is populated, that JSON *is* the observed data — you do not need track-service, ClickHouse, or live event queries. Parse it directly and use it for analysis.

Trigger analysis by POSTing to `/api/experiments/<experimentId>/analyze` with `{runId}`. The endpoint automatically falls back to the stored `inputData` when `featbitEnvId` / `flagKey` are not wired up (expert-mode experiments with no FeatBit flag). The response includes `dataSource: "live" | "stored"` so you can tell the user where numbers came from.

If the user asks "do you have my data?" or "can you see what I entered?", read `inputData` and confirm concretely: event name, per-variant n/k (or n/sum/sum_squares), guardrail events, inverse flags — not "I can't reach the database."

### Respect the `inverse` flag — do not override the verdict

The analyzer's `verdict` and `p_harm` values **already account for each metric's `inverse` flag** (read from the guardrails JSON on the experiment and from `metrics[event].inverse` in `inputData`). They are authoritative.

**Hard rules:**

1. **Do not quote metrics that don't exist.** The analyzer outputs `p_harm` (probability of harm) and `p_win` (probability of win) — they are complements. Never write things like "P(win) ≈ 0% so rollback" when the actual output field is `p_harm = 0`. That's inventing numbers.
2. **Do not override the analyzer's `verdict` silently.** If the analyzer says `"guardrail healthy"` and `p_harm = 0`, that is the evidence. Your job is to frame it, not flip it.
3. **When your intuition disagrees with the verdict, flag the configuration.** If a guardrail shows `rel_delta` with large magnitude (say |Δ| ≥ 50%) but `verdict: "guardrail healthy"` and `p_harm ≈ 0`, the most likely explanation is that `inverse` is set the wrong way for what the user actually meant. Ask, don't assume:

   > "gtest moved from 2.3% to 20% (+770%), and the analyzer reports P(harm)=0 with verdict `healthy`. That's because the guardrail is configured as 'higher is better' (`inverse=false`). If this metric is actually 'lower is better' (e.g. error rate, abandonment, latency), flip `inverse` in the setup and re-run — the verdict will change. Which did you mean?"

4. **If the user confirms the config is correct**, go with the analyzer's verdict. A +770% move on a higher-is-better guardrail is not harm.
5. **If the user confirms inverse was wrong**, they need to toggle it in the wizard (Edit setup) and re-analyze. Do not pretend the flipped-direction numbers apply to the current run record — they don't until the re-analysis writes a fresh `analysisResult`.

This rule exists because a previous run produced a ROLLBACK decision by misquoting `p_harm=0` as `P(win)≈0%` and ignoring `inverse=false`. That fabrication is not allowed.

## Decision Actions

### Evidence sufficiency check (CF-06 first)

Before interpreting results, confirm:

1. **Simultaneous?** — Are both variants measured over the same time window?
2. **Sufficient volume?** — Sample per variant ≥ `minimumSample` in the experiment record. If below this floor, the Gaussian approximation is unreliable — do not interpret P(win) or risk values yet.
3. **Risk has had a chance to converge?** — Read the experiment's `analysisResult` and check that `risk[trt]` and `risk[ctrl]` are not both still very high (> 0.02). If both are high, the posterior is still wide — more data is needed regardless of what P(win) shows.
4. **Clean window?** — Were there external events (promotions, outages, holidays) that could contaminate the data?
5. **Instrumentation verified?** — Are events firing correctly for both variants?
6. **SRM check passed?** — `analysisResult` includes a χ² SRM check. If it flags an imbalance (p < 0.01), do not interpret metric results until the traffic split issue is resolved.

If any check fails, the right move is NOT to decide — it is to wait, fix, or extend.

### Decision framing (CF-07)

Once evidence is sufficient, read the experiment's `analysisResult` and frame the outcome using exactly one of these categories:

- **CONTINUE** — Primary metric P(win) ≥ 95% and risk[trt] is low. Guardrail P(win) all > 20%. Proceed with planned expansion.
- **PAUSE** — Primary metric P(win) 80–95%, or a guardrail P(win) ≤ 20%, or SRM check failed. Signal exists but is not clean enough to expand. Investigate before proceeding.
- **ROLLBACK CANDIDATE** — A guardrail P(win) ≤ 5%, or primary metric P(win) ≤ 5%. Evidence of harm. Flag should be reverted.
- **INCONCLUSIVE** — Sample below validity floor, or risk[trt] and risk[ctrl] both still high, or primary metric P(win) 20–80% after a full observation window. Extend window or revisit instrumentation.

See [references/decision-framing-guide.md](references/decision-framing-guide.md) for how to write each category's decision statement and what counts as "low" for risk values.

### Produce the decision artifact

Write a structured decision statement with:
- The recommendation category
- The evidence that supports it (numbers, not vague descriptions)
- The link back to the original hypothesis
- The explicit next action

## Operating Rules

- Do not let urgency substitute for evidence
- "Not enough data" is a valid and honest decision frame — do not dress it up when the real issue is impatience
- Separate "we don't know yet" from "we know it's harmful"
- Hand off to `learning-capture` immediately after the decision is made

### Persist State

Use `Skill("project-sync", ...)` to sync state. Stage stays at `measuring` — no stage advance here (the project stage advances to `learning` only when `learning-capture` completes):

```python
assert Skill("project-sync", f'update-state {experiment_id} --lastAction "Decision: {category}"').ok
# stage stays at measuring — do NOT call set-stage here
assert Skill("project-sync", f'record-decision {experiment_id} {slug} --decision {category} --decisionSummary "{summary}" --decisionReason "{reason}"').ok
assert Skill("project-sync", f'decide-run {experiment_id} {slug}').ok
assert Skill("project-sync", f'add-activity {experiment_id} --type decision_recorded --title "Decision: {category}"').ok
```

## Execution Procedure

```python
def analyze_evidence(project_id, user_message):
    state = Skill("project-sync", f"get-experiment {project_id}")
    if state.primaryMetric in ("", None):
        Skill("measurement-design", project_id)
        return
    active_run = pick_active_run(state)  # run in collecting or analyzing status
    # --- 6-check sufficiency gate ---
    checks = [
        check_simultaneous(active_run),
        check_volume(active_run),         # n >= minimumSample per variant
        check_risk_convergence(active_run),
        check_clean_window(active_run),
        check_instrumentation(active_run),
        check_srm(active_run),            # chi-sq p >= 0.01
    ]
    if any(check.failed for check in checks):
        say(format_insufficiency(checks))
        return  # do not produce a decision; do not write record-decision
    # --- 6-rule classification cascade ---
    category = classify(active_run.analysisResult)
    # ROLLBACK: guardrail P(win) <= 5% or primary P(win) <= 5%
    # PAUSE guardrail: guardrail P(win) <= 20%
    # CONTINUE: primary P(win) >= 95% and risk[trt] low and all guardrails > 20%
    # PAUSE primary: primary P(win) 80-95%
    # INCONCLUSIVE: P(win) 20-80% after full window, or risk both still high
    # lean-control: P(win) < 20% but above ROLLBACK threshold
    summary, reason = build_decision_artifact(category, active_run)
    assert Skill("project-sync", f'update-state {project_id} --lastAction "Decision: {category}"').ok
    assert Skill("project-sync", f'record-decision {project_id} {active_run.slug} --decision {category} --decisionSummary "{summary}" --decisionReason "{reason}"').ok
    assert Skill("project-sync", f'decide-run {project_id} {active_run.slug}').ok
    assert Skill("project-sync", f'add-activity {project_id} --type decision_recorded --title "Decision: {category}"').ok
    Skill("learning-capture", project_id)
```

## Signal Inference

| Check | Rule |
|---|---|
| `primaryMetric` empty | Redirect to `measurement-design` |
| No active run | Check experiment records — may need `experiment-workspace` to start one |
| SRM check fails | Stop; do not interpret metric results; investigate traffic split |
| Both risk values still high | More data needed; do not decide — wait |
| User impatient with sample below floor | Explain: below `minimumSample`, Gaussian approximation is unreliable |
| INCONCLUSIVE | Still requires a written decision artifact — "we don't know yet" is a valid and complete frame |

## Reference Files

- [references/decision-framing-guide.md](references/decision-framing-guide.md) — CONTINUE/PAUSE/ROLLBACK CANDIDATE/INCONCLUSIVE language, decision statement template, common framing mistakes
- [references/tool-featbit-abtesting.md](references/tool-featbit-abtesting.md) — FeatBit experiment dashboard, reading per-variant results, confidence interpretation
