---
name: Tool Adapter: FeatBit AB Testing Toolkit
description: FeatBit experiment dashboard usage: reading per-variant results, confidence interpretation, and AB testing UI reference.
---

# Tool Adapter: FeatBit AB Testing Toolkit

**Vendor:** FeatBit  
**Tool type:** Experiment dashboard + Bayesian analysis  
**Default for skill:** `evidence-analysis`

This file describes how to use FeatBit's experiment features to read and interpret A/B test results.

---

## Prerequisites

- A feature flag with at least two variants (control and treatment)
- Custom events tracked via FeatBit SDK using the same `user_key` as flag evaluations
- An experiment created in FeatBit linking the flag to the metrics

---

## Setting Up an Experiment

In the FeatBit UI:

1. Navigate to **Experiments** → **Create Experiment**
2. Link the experiment to the feature flag key
3. Define the primary metric (linked to a tracked event name)
4. Optionally define guardrail metrics (additional tracked events)
5. Set the observation window start date
6. Save and activate the experiment

The experiment begins collecting metric data once:
- The flag is enabled
- Users are being assigned to variants
- Events are being tracked with the same user keys as the flag evaluations

---

## Reading Results

FeatBit's experiment dashboard shows per-variant data:

| Column | Meaning |
|---|---|
| **Variant** | Control or Treatment label |
| **Exposures** | Unique users assigned this variant |
| **Conversions** | Users who triggered the primary metric event |
| **Rate** | Conversion rate (conversions / exposures) |
| **Relative change** | Candidate rate vs. baseline rate |
| **Confidence** | Statistical confidence in the observed difference |

Read guardrail metrics in the same view — they appear as secondary metric rows.

---

## Interpreting the Confidence Value

FeatBit uses Bayesian inference for experiment analysis (verify against your version's documentation).

Guidance for applying to decision categories:

| Confidence | Interpretation | Likely category |
|---|---|---|
| > 95% | Strong directional signal | CONTINUE or ROLLBACK CANDIDATE |
| 80–95% | Moderate signal — consider extending | PAUSE or extend window |
| < 80% | Insufficient evidence | INCONCLUSIVE |

These are guidelines, not rules. Business context, guardrail health, and traffic volume all matter. Use `decision-framing-guide.md` for the final framing.

---

## After Making a Decision

1. Persist the decision to the database via `project-sync` `upsert-experiment` (`--decision` + `--decisionSummary` + `--decisionReason`)
2. If **CONTINUE**: run the rollout expansion command via `tool-featbit-cli.md`
3. If **ROLLBACK CANDIDATE**: disable the flag immediately, then archive the experiment
4. If **INCONCLUSIVE**: extend the window or close without action and document why

Archive the experiment after the flag is fully rolled out or rolled back to preserve the result data for the `learning-capture` cycle.

---

## Reference

For full FeatBit experiment documentation, see [FeatBit Experimentation documentation](https://docs.featbit.co/experimentation/overview).
