---
name: Decision Framing Guide
description: CONTINUE / PAUSE / ROLLBACK CANDIDATE / INCONCLUSIVE language, decision statement template, and common framing mistakes for evidence-analysis.
---

# Decision Framing Guide

## TOC

- [The Four Categories](#the-four-categories)
- [Common Framing Mistakes](#common-framing-mistakes)
- [Decision Statement Template](#decision-statement-template)

## The Four Categories

These are **action categories**, not statistical verdicts. They exist to produce a clear next step, not a scientific conclusion.

---

### CONTINUE

**Meaning:** The evidence supports proceeding with the planned rollout expansion.

**Conditions (read from experiment's `analysisResult`):**
- Primary metric P(win) ≥ 95%
- Primary metric risk[trt] is low (< 0.01 as a general reference — calibrate to your metric's business impact)
- All guardrail P(win) > 20% (no harm signal on any guardrail)
- Observation window is complete (≥ one full business cycle)
- SRM check passed

**What to say:**
> "The primary metric [metric name] shows P(win) = [X]% with risk[trt] = [value] for the candidate variant. Guardrails are healthy (all P(win) > 20%). Recommend proceeding to Phase 2 at [next %]."

---

### PAUSE

**Meaning:** Something needs investigation before the rollout expands. Not necessarily harmful — signal is mixed or incomplete.

**Conditions (read from experiment's `analysisResult`):**
- Primary metric P(win) is 80–95% (leaning positive but not conclusive)
- Or a guardrail P(win) ≤ 20% (possible harm — not yet confirmed)
- Or risk[trt] is above 0.01 despite high P(win) (the downside of being wrong is meaningful)
- Or SRM check failed (χ² p < 0.01) — traffic split is compromised, investigate before expanding
- Or an instrumentation anomaly was detected

**What to say:**
> "The primary metric shows P(win) = [X]%, but [guardrail metric] P(win) = [Y]% — a possible harm signal. Recommend pausing at current exposure while investigating [specific signal]."

---

### ROLLBACK CANDIDATE

**Meaning:** Evidence indicates the candidate variant is causing harm.

**Conditions (read from experiment's `analysisResult`):**
- A guardrail P(win) ≤ 5% (strong harm signal on a protected metric)
- Or primary metric P(win) ≤ 5% (treatment is very likely worse)
- Or critical errors or regressions are directly attributable to the candidate variant

**What to say:**
> "Evidence indicates the candidate variant is degrading [guardrail metric]: P(win) = [X]%, risk[ctrl] = [value]. Recommend disabling the candidate variant immediately and investigating [root cause area]."

Do NOT soften ROLLBACK CANDIDATE language. Clarity is operational here.

---

### INCONCLUSIVE

**Meaning:** The collected evidence is genuinely insufficient to support a directional decision.

**Conditions (read from experiment's `analysisResult`):**
- Sample per variant is below `minimumSample` in the experiment record
- Or risk[trt] and risk[ctrl] are both still high (> 0.02) — posterior has not yet narrowed enough
- Or primary metric P(win) is 20–80% after a full observation window has elapsed
- Or external contamination (holiday, marketing event, outage) compromised the window

**What to say:**
> "Current evidence is insufficient for a directional decision. [N] exposures per variant collected over [X days]. Primary metric P(win) = [X]% with risk[trt] = [value] — posterior has not converged. Recommend extending the observation window to cover at least one full business cycle (≥ 7 days) before deciding."

---

## Common Framing Mistakes

**Calling INCONCLUSIVE when you mean CONTINUE**  
If the primary metric is positive but you're uncertain, that's CONTINUE with a confidence note — not INCONCLUSIVE.

**Calling PAUSE when you mean ROLLBACK CANDIDATE**  
Do not soften "evidence of harm" into "let's investigate." If a pre-defined rollback threshold was crossed, the category is ROLLBACK CANDIDATE regardless of discomfort with the decision.

**Citing P(win) alone without risk**
P(win) = 94% sounds convincing, but if risk[trt] is still high (> 0.01), the downside of being wrong is meaningful. Always pair P(win) with risk[trt] when framing a CONTINUE recommendation. "P(win) = 96%, risk[trt] = 0.003 across 4,200 exposures" is an actionable statement. "P(win) = 94%" alone is not.

**Describing magnitude in statistical terms instead of business terms**
"P(win) = 97%" tells reviewers nothing about the actual change. "Click rate increased from 5.1% to 6.3% (+24% relative) with P(win) = 97%" does.

**Waiting for certainty before framing**  
These categories support decisions under uncertainty. INCONCLUSIVE is a valid and honest frame — use it rather than delaying.

---

## Decision Statement Template

```
Experiment:         [flag key / experiment name]
Observation window: [start date] to [end date]
Sample:             [N users per variant] — minimum required: [minimum_sample_per_variant]
SRM check:          [✓ ok / ⚠ failed — p = X]

Hypothesis: [from project state]

Primary metric: [metric name]
  Baseline (control):  [rate or mean]
  Candidate:           [rate or mean]
  Relative change:     [rel Δ from analysisResult]
  P(win):              [X]%
  risk[trt]:           [value]
  risk[ctrl]:          [value]
  95% credible CI:     [lower, upper]

Guardrails:
  [guardrail 1]: P(win) = [X]%  — [healthy / possible harm / strong harm]
  [guardrail 2]: P(win) = [X]%  — [healthy / possible harm / strong harm]

Decision: [CONTINUE / PAUSE / ROLLBACK CANDIDATE / INCONCLUSIVE]

Reasoning: [2–3 sentences tying the evidence to the hypothesis and the decision category]

Next action: [specific step — expand to X%, disable flag, extend window, investigate Y]
```
