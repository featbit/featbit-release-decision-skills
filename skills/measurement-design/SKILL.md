---
name: measurement-design
description: Defines the primary success metric, guardrails, and event instrumentation for a hypothesis before exposure begins. Activate when triggered by CF-05 from the release-decision framework, or when user asks "how do I measure this", "what metrics should I use", "what should I track", "how do I instrument this", "event design", "what is the primary metric". Do not use when metrics are already well-defined and instrumentation is complete.
license: Apache-2.0
metadata:
  author: FeatBit
  version: "1.1.0"
  category: release-management
---

# Measurement Design

This skill handles **CF-05: Measurement Discipline** from the release-decision framework.

Its job is to ensure every hypothesis has exactly one primary metric with a clear "better" direction, a small set of guardrails with alarm directions, and an event schema that can produce evidence for the decision.

## When to Activate

- Hypothesis exists but no primary metric is defined
- User names multiple competing success metrics
- User mixes goals, proxies, and diagnostics together
- Instrumentation does not exist for the desired outcome
- Project `primaryMetric` field is empty or contains a list

## On Entry — Read Current State

Before doing any work, call `featbit_release_decision_get_experiment` through the configured FeatBit experimentation MCP server.

Check these fields:

| Field | Purpose |
|---|---|
| `hypothesis` | Confirms causal claim exists |
| `primaryMetric` | Current metric definition (may be empty) |
| `guardrails` | Existing guardrail metrics |
| `stage` | Current lifecycle position |

- If `hypothesis` is empty → redirect to `hypothesis-design`
- If `primaryMetric` is already defined and instrumentation is confirmed → may not need this skill
- If `guardrails` already exist → build on existing rather than overwriting

## Core Principle

**One primary metric decides the outcome. Everything else is a guardrail or diagnostic.**

If two metrics both "decide" success, the decision is not yet sharp enough. Return to `hypothesis-design`.

## Decision Actions

### Define the primary metric

Ask: "If this experiment runs for 2 weeks and you had to make a go/no-go decision with ONE number, what is that number?"

The answer is the primary metric. One only.

Then capture it as a structured object — NOT a paragraph. The six fields are:

| Field | Purpose | Example |
|---|---|---|
| `name` | Short human-readable label, 80 characters or fewer (shows in the web UI's metric table) | `"Signup conversion"` |
| `event` | Instrumented event key emitted from code, 128 characters or fewer, no spaces | `"signup_completed"` |
| `metricType` | `binary` for conversion (fires 0/1) or `continuous` for a value (revenue, latency, count per user) | `"binary"` |
| `metricAgg` | `once` (max 1 per user, for funnel conversion), `count` (tally all occurrences), `sum` (add numeric payloads), or `average` (mean of values per user) | `"once"` |
| `expectedDirection` | Which direction is better for the primary metric: `increase_good` or `decrease_good` | `"increase_good"` |
| `description` | One-sentence rationale — why this metric decides go/no-go, including the better direction | `"Higher signup conversion is better because it directly measures the H1 change."` |

If the user gives a vague metric name (e.g. "signup rate"), probe until the event key, metric type, aggregation, and expected better direction are concrete. Don't proceed with a half-defined metric.

MCP payload note: `featbit_release_decision_update_metrics` requires `metricName`, `metricEvent`, `metricType`, `metricAgg`, and `expectedDirection`. `expectedDirection` must be exactly `increase_good` or `decrease_good`; missing or invalid values should be treated as an error and corrected before retrying. Do not invent `metricDirection`, `primaryMetricDirection`, or primary-metric `inverse` in the update payload.

### Define guardrails (2–3 maximum)

Ask: "What other metrics would concern you if they degraded significantly, even if the primary metric improved?"

Common guardrails:
- Error rate / p99 latency for the candidate variant
- User satisfaction score or support ticket volume
- A downstream conversion step after the primary metric

Each guardrail has the same five fields as the primary metric, **plus**:

| Field | Purpose | Example |
|---|---|---|
| `direction` | `increase_bad` (e.g. error rate, abandonment) or `decrease_bad` (e.g. downstream retention) | `"increase_bad"` |

### Design the event

For each metric, define:
- Event name (what action fires it)
- Required properties (user_key, session_id, relevant context)
- Where in the user journey it fires
- Whether it needs to be associated with a flag evaluation for experiment analysis

### Verify instrumentation completeness

Check: can the current codebase emit this event? If not, instrumentation must be built before exposure begins.

## Operating Rules

- Do not allow exposure to start without confirmed instrumentation
- One primary metric only — push back on lists
- Primary metric direction is mandatory. Capture whether higher or lower is better before writing metrics.
- Guardrails protect against harm, not success. They should not be optimized for.
- Guardrail direction means alarm direction (`increase_bad` or `decrease_bad`); do not reuse those labels for the primary metric.
- When multiple experiments share a flag or user pool, verify traffic allocation strategy before calculating sample size. Sequential experiments get full traffic; concurrent experiments with mutual exclusion get only their slice. An underpowered experiment due to traffic splitting is worse than waiting for a sequential slot. See `reversible-exposure-control` → [multi-experiment-traffic.md](../reversible-exposure-control/references/multi-experiment-traffic.md) for patterns.
- Hand off to `experiment-workspace` when instrumentation is complete and the user is ready to start or configure a run
- Hand off to `evidence-analysis` once data collection is underway and analysis output exists
- After CF-05 is persisted, tell the user the UI next step: mark Measuring satisfied only after event instrumentation and run setup are ready; then proceed to data collection / analysis.

### Persist State

Use FeatBit experimentation MCP tools to sync state, and confirm instrumentation before writing. Primary metrics must be written through `featbit_release_decision_update_metrics`, not `featbit_release_decision_update_experiment`.

```python
MCP("featbit_release_decision_update_metrics", experimentId=experiment_id, update={
    "metricName": primary_metric_name,
    "metricEvent": primary_metric_event,
    "metricType": primary_metric_type,
    "metricAgg": primary_metric_agg,
    "expectedDirection": primary_metric_expected_direction,
    "metricDescription": primary_metric_description,
    "guardrails": guardrails_json,
})
MCP("featbit_release_decision_update_experiment", experimentId=experiment_id, update={
    "lastAction": "Metrics defined",
})
MCP("featbit_release_decision_set_stage", experimentId=experiment_id, stage="measuring")
```

`metricName`, `metricEvent`, `metricType`, `metricAgg`, and `expectedDirection` are all required. The web UI renders each field as its own column — do NOT jam a paragraph into `metricName`. Keep `metricName` 80 characters or fewer, and keep `metricEvent` as a key with no spaces. Rationale goes in `metricDescription`; better direction goes in `expectedDirection`.

**`guardrails` must be a JSON array** of objects with the primary-metric shape plus `direction` (`increase_bad` or `decrease_bad`). One entry per guardrail, never a single string or newline-separated text.

The FeatBit API validates the primary metric event/type/aggregation and guardrail JSON shape/enums; if validation fails, correct the payload and retry once.

## Execution Procedure

```python
def design_measurement(experiment_id, user_message):
    state = MCP("featbit_release_decision_get_experiment", experimentId=experiment_id)
    if state.hypothesis in ("", None):
        Skill("hypothesis-design", experiment_id)
        return
    # --- primary metric ---
    # ask: "if you had ONE number to make a go/no-go decision, what is it?"
    primary_metric = elicit_primary_metric(state, user_message)
    # --- guardrails (2–3 max) ---
    guardrails = elicit_guardrails(state)
    # --- event design ---
    events = design_events(primary_metric, guardrails)
    # --- instrumentation gate ---
    instrumentation_confirmed = confirm_instrumentation(events)
    if not instrumentation_confirmed:
        say("Instrumentation must be confirmed before exposure begins.")
        return  # do not advance stage until confirmed
    guardrails_json = json.dumps([
        {
            "name":        g.name,
            "event":       g.event,
            "metricType":  g.metric_type,
            "metricAgg":   g.metric_agg,
            "direction":   g.direction,                  # increase_bad | decrease_bad
            "description": g.rationale,
        }
        for g in guardrails
    ])
    MCP("featbit_release_decision_update_metrics", experimentId=experiment_id, update={
        "metricName": primary_metric.name,
        "metricEvent": primary_metric.event,
        "metricType": primary_metric.metric_type,       # binary | continuous
        "metricAgg":  primary_metric.metric_agg,        # once | count | sum | average
        "expectedDirection": primary_metric.expected_direction,  # increase_good | decrease_good
        "metricDescription": primary_metric.rationale,
        "guardrails": guardrails_json,
    })
    MCP("featbit_release_decision_update_experiment", experimentId=experiment_id, update={
        "lastAction": "Metrics defined",
    })
    MCP("featbit_release_decision_set_stage", experimentId=experiment_id, stage="measuring")
    say("In the UI, mark the Measuring step satisfied only after the event contract is saved and instrumentation is ready; then continue to the run setup / data collection prompt.")
    Skill("experiment-workspace", experiment_id)
```

## Signal Inference

| Check | Rule |
|---|---|
| `hypothesis` empty | Redirect to `hypothesis-design` |
| User lists multiple "primary" metrics | Push back — ask which ONE decides the go/no-go |
| Primary metric lacks better direction | Ask whether higher or lower is better before writing metrics |
| Guardrail count > 3 | Ask which 2–3 matter most; trim the rest to diagnostics |
| Instrumentation not confirmed | Block stage advance; do not set stage to `measuring` |
| Traffic split planned (concurrent experiments) | Flag that sample size must be calculated on the reduced traffic slice, not full traffic |

## Reference Files

- [references/event-schema-design.md](references/event-schema-design.md) — TrackPayload shape, event naming conventions, metric-to-event mapping, anti-patterns
- [references/tool-featbit-sdk.md](references/tool-featbit-sdk.md) — FeatBit SDK track() usage, experiment event association, sendToExperiment
