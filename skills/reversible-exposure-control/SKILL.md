---
name: reversible-exposure-control
description: Makes product or AI changes reversible before they are visible, and defines the feature flag contract, variants, targeting, rollout, rollback, and expansion rules. Activate when triggered by CF-03 or CF-04 from the release-decision framework, or when user says "feature flag", "should I ship this", "rollout strategy", "gradual rollout", "canary", "5% of users", "start exposing", "who sees this first", "create a flag", "add flag to code", or asks what flag should be created. Default to guiding what feature flag and exposure contract should exist; FeatBit CLI and Web UI references are optional operator adapters after the contract is clear.
license: Apache-2.0
metadata:
  author: FeatBit
  version: "1.2.0"
  category: release-management
---

# Reversible Exposure Control

This skill handles **CF-03: Reversible Change Control** and **CF-04: Exposure Strategy** from the release-decision framework.

These two control principles are handled together because they represent a single user decision intent: "I want to start showing this to users in a controlled way."

## When to Activate

- A change is about to be implemented that will affect user behavior, adoption, or outcomes
- A change exists but is not yet behind a feature flag (not reversible)
- A feature flag exists but exposure strategy is undefined or implicit
- User asks about rollout percentages, targeting, or who should see a variant
- Project stage is `implementing` or `exposing`

## On Entry — Read Current State

Before doing any work, call `featbit_release_decision_get_experiment` through the configured FeatBit experimentation MCP server.

Check these fields:

| Field | Purpose |
|---|---|
| `goal` | Confirms business outcome exists |
| `hypothesis` | Confirms causal claim exists |
| `constraints` | Existing flag contract / rollout constraints |
| `stage` | Current lifecycle position |

- If `hypothesis` is empty → redirect to `hypothesis-design`
- If `stage` is already `exposing` → resume from rollout / expansion rather than restarting
- If `constraints` already has flag contract details → build on existing rather than overwriting

## Default Operating Mode

Do not ask whether the user wants a PM/dev handoff or wants the agent to create the FeatBit flag directly.

The default output is always a concrete **feature flag and exposure contract**: what flag should exist, what variants it should serve, where it should be evaluated, who should see each variant, how rollout starts, what stops it, and what evidence allows expansion.

The current release-decision MCP tools persist experiment state, metrics, runs, and messages. They do not create or mutate FeatBit feature flags directly. Do not claim to have created a feature flag through MCP unless a separate feature-flag MCP tool is actually available in the session. When direct flag tooling is unavailable, tell the user what to create in the FeatBit UI or through their existing flag automation.

## Decision Actions (by user intent)

### Define the feature flag and exposure contract

1. Confirm the business goal, hypothesis, and primary metric already exist
2. Define the flag contract: human-readable name, stable key, flag type, and variants
3. Define the implementation decision point: where the flag should be evaluated and what behavior changes per variant
4. Define targeting and protection rules: who sees the candidate first, who must not see it, and which user attribute controls assignment
5. Define rollout logic: initial exposure, expansion checkpoints, stop conditions, and rollback triggers
6. Define metric-event requirements that must be emitted after exposure; the metric event contract remains owned by `measurement-design` and can be persisted through `featbit_release_decision_update_metrics`
7. Package the result as an implementation-ready contract using [references/pm-dev-handoff.md](references/pm-dev-handoff.md)

### If the user asks how to create the flag in FeatBit

Answer with the concrete flag values from the contract. Do not ask who will create it.

1. Confirm feature flag key naming (kebab-case, descriptive, environment-agnostic)
2. Define variants: baseline (control) and candidate (treatment) — if non-boolean, set up variants in the web UI first
3. Tell the user to create the flag in the FeatBit UI in the current Env shown by the release-decision page, initially OFF or limited to an internal/test audience
4. For multi-variant flags or custom variation values: use [references/tool-featbit-webui.md](references/tool-featbit-webui.md)
5. If a dedicated FeatBit flag MCP/CLI tool is actually available, it may be used after the user confirms the concrete flag contract; otherwise persist only the release-decision state through MCP

### "I want to start rolling this out"

1. Confirm hypothesis and primary metric exist first
2. Confirm who is protected (must NOT see the candidate)
3. Set initial exposure: default 5–10%
4. Define expansion criteria in advance — what evidence justifies moving to 25%, 50%, 100%
5. Define rollback triggers — what signals cause immediate revert
6. Read: [references/rollout-patterns.md](references/rollout-patterns.md) for strategy
7. Tell the user which rollout rule to configure in the FeatBit UI or existing flag automation
8. To rollback, route users back to the control/default variation or disable the candidate path

### "I want to target a specific audience"

1. Identify the targeting rule: user property, segment, or custom attribute
2. Confirm this audience is the right proxy for the hypothesis audience
3. Set audience filters on the experiment record via the FeatBit web UI (Targeting → Attribute conditions). The `audienceFilters` field exists in the DB schema but has no CLI command yet — use the web UI. See `note.important.txt` at the repo root for the deferred action plan. The data server applies these filters when querying experiment data
4. Describe the targeting logic in the contract instead of asking who owns flag operations
5. Set targeting rules in the FeatBit web UI before enabling the flag — see [references/tool-featbit-webui.md](references/tool-featbit-webui.md) for targeting rule setup
6. After rules are set, proceed to rollout using the exposure contract above

### "I want to add the feature flag to my code"

Name the exact insertion point and expected variant behavior. Do not ask whether the current user or another team owns the code.

1. Identify the language or framework in use
2. Install the FeatBit SDK skill: `npx skills add featbit/featbit-skills --skill featbit-sdks-[language]`
3. Follow the SDK skill to add the `variation()` call at the correct point in the code path
4. Use [references/tool-featbit-cli.md](references/tool-featbit-cli.md) only if the CLI is available; otherwise verify the flag key in the FeatBit UI

### "I have multiple experiments planned on the same flag or surface"

1. Determine whether experiments are sequential or must run concurrently
2. Default to **sequential** design: run Experiment 1 to conclusion, then start Experiment 2. This avoids mutual-exclusion complexity and gives each experiment the full traffic pool
3. If experiments must run concurrently on the same surface, use **mutual exclusion**: partition traffic into non-overlapping hash buckets. Each experiment gets `[trafficOffset, trafficOffset + trafficPercent)` — e.g. Exp A offset=0/50%, Exp B offset=50/50%. Leave `layerId` null — it is a WHERE-clause filter on evaluation records, not a mechanism for independent assignment
4. Choose the analysis method: `bayesian_ab` (default, balanced sampling — equal N per variant) or `bandit` (pass-through — asymmetric allocation intentional). Set this in the experiment record's `method` field via the web UI. The data server applies the appropriate sampling strategy automatically
5. If experiments are concurrent but on independent features or surfaces with no shared metrics, that is an **orthogonal** design — each experiment gets its own flag and project. This is knowledge-only guidance; it is not an operation performed within a single project
6. Run sample-size calculations on the reduced traffic pool for concurrent designs — underpowered experiments are worse than sequential with a wait
7. Document the chosen strategy in the handoff spec and in the exposure activity log
8. Read: [references/multi-experiment-traffic.md](references/multi-experiment-traffic.md) for detailed patterns and anti-patterns

## Operating Rules

- Reversibility (feature flag exists) must be confirmed before exposure begins
- Never start at 100% unless protected audience targeting is explicitly intentional
- Default to a written feature flag and exposure contract; do not block on ownership
- Treat FeatBit CLI and Web UI as optional adapters, not the required workflow of this skill
- The important artifact is the flag contract and rollout intent; the vendor tool is secondary
- Hand off to `measurement-design` if instrumentation is not confirmed before exposure begins
- After the contract is persisted, tell the user the UI next step: mark the current Exposure step satisfied, create/configure the flag in FeatBit UI using the contract, then continue to Measuring / CF-05 for metric events and analysis setup

### Persist State

Use FeatBit experimentation MCP tools to sync state. Both writes are required:

```python
MCP("featbit_release_decision_update_experiment", experimentId=experiment_id, update={
    "constraints": flag_contract_and_rollout,
    "lastAction": what_was_done,
})
MCP("featbit_release_decision_set_stage", experimentId=experiment_id, stage="implementing")
# Note: only two valid stages apply here: "implementing" (flag contract defined, not yet live)
# Stage stays at "implementing" throughout; there is no "exposing" stage value.
```

## Execution Procedure

```python
def control_exposure(experiment_id, user_message):
    state = MCP("featbit_release_decision_get_experiment", experimentId=experiment_id)
    if state.hypothesis in ("", None):
        Skill("hypothesis-design", experiment_id); return
    # Always produce a flag/exposure contract first. Direct flag mutation is
    # allowed only when a dedicated feature-flag tool is actually available.
    contract = build_handoff(state, read("references/pm-dev-handoff.md"))
    assert cf03_and_cf04_pass(state, contract), "define flag contract and rollout plan before enabling"
    say(contract)
    constraints = contract
    action = "Exposure contract defined"
    MCP("featbit_release_decision_update_experiment", experimentId=experiment_id, update={
        "constraints": constraints,
        "lastAction": action,
    })
    MCP("featbit_release_decision_set_stage", experimentId=experiment_id, stage="implementing")
```

## Signal Inference

| Check | Rule |
|---|---|
| User asks who should create the flag | Do not ask ownership; define the flag contract and UI/automation next steps |
| `hypothesis` empty | Redirect to `hypothesis-design` before any flag work |
| `constraints` already has flag contract | Build on existing rather than overwriting |
| User asks about `audienceFilters` | Deferred: field exists in Prisma but no CLI command yet — use FeatBit web UI. See `note.important.txt` at repo root |
| Multiple experiments planned | Classify as sequential / mutual-exclusion / orthogonal; require explicit traffic isolation strategy |
| Stage already `implementing` | Resume from current rollout state; do not restart |

## Reference Files

- [references/rollout-patterns.md](references/rollout-patterns.md) — vendor-agnostic rollout strategy, progressive exposure, protected audience guidance
- [references/multi-experiment-traffic.md](references/multi-experiment-traffic.md) — sequential, mutual-exclusion, and orthogonal patterns for multi-experiment traffic allocation
- [references/pm-dev-handoff.md](references/pm-dev-handoff.md) — PM or experiment owner handoff template for the team that owns code, wrappers, and flag operations
- [references/tool-featbit-cli.md](references/tool-featbit-cli.md) — FeatBit CLI: config, inspect, flag create/toggle/archive/set-rollout/evaluate, SDK integration via featbit-skills
- [references/tool-featbit-webui.md](references/tool-featbit-webui.md) — FeatBit web UI: targeting rules, multi-variant setup, audit trail, RBAC management
