---
name: project-sync
description: Deprecated compatibility note for old release-decision skills that used the local `sync.ts` CLI bridge. New skills must use the configured FeatBit experimentation MCP tools instead of scripts. Activate only when migrating old instructions that mention project-sync, sync.ts, update-state, set-stage, add-activity, create-run, analyze-run, decide-run, archive-run, record-decision, save-learning, or get-experiment.
license: Apache-2.0
metadata:
  author: FeatBit
  version: "3.0.0"
  category: release-management
---

# Project Sync — Deprecated Script Bridge

This skill is retained only as a migration note. The old flow was:

```
Agent skill -> project-sync -> sync.ts -> web API -> database
```

The new flow is:

```
Agent skill -> configured FeatBit experimentation MCP server -> FeatBit API -> database
```

Do not call `sync.ts`, do not set `SYNC_API_URL`, and do not require a per-experiment access token in the slash command.

## MCP Contract

Use the configured FeatBit experimentation MCP server for all release-decision state. The MCP client configuration must provide normal FeatBit auth, including:

- `Authorization: Bearer <token>`
- `Organization: <organization-id>`
- `Workspace: <workspace-id>`

Every tool call that touches experiment data must pass `envId` and `experimentId`. The server checks environment access on each call.

Available tools:

| MCP tool | Replaces old script command |
|---|---|
| `featbit_release_decision_get_experiment` | `get-experiment` |
| `featbit_release_decision_update_experiment` | `update-state` |
| `featbit_release_decision_set_stage` | `set-stage` |
| `featbit_release_decision_update_metrics` | metric fields in `update-state` |
| `featbit_release_decision_create_run` | `create-run` |
| `featbit_release_decision_update_run` | `start-run`, `analyze-run`, `decide-run`, `archive-run`, `save-input`, `save-result`, `record-decision`, `save-learning` |
| `featbit_release_decision_analyze_run` | server-side `analyze-run` |
| `featbit_release_decision_add_message` | conversation/history writes |

## Standard Write Pattern

For each stage transition:

1. Call `featbit_release_decision_update_experiment` with the fields produced by the stage.
2. Call `featbit_release_decision_set_stage`.
3. Call `featbit_release_decision_add_message` only when there is user-visible conversation or a decision note worth preserving.

For run changes:

1. Call `featbit_release_decision_create_run` if no run exists.
2. Call `featbit_release_decision_update_run` for run setup, status transitions, decisions, and learning fields.
3. Call `featbit_release_decision_analyze_run` for analysis; do not synthesize `analysisResult` locally unless explicitly debugging the analysis engine.

## Canonical Values

Use only these values when writing state:

| Field | Values |
|---|---|
| `stage` | `intent`, `hypothesis`, `implementing`, `measuring`, `learning` |
| `run status` | `draft`, `collecting`, `analyzing`, `decided`, `archived` |
| `method` | `bayesian_ab`, `frequentist`, `bandit` |
| `decision` | `CONTINUE`, `PAUSE`, `ROLLBACK`, `INCONCLUSIVE` |
| `metricType` | `binary`, `continuous` |
| `metricAgg` | `once`, `count`, `sum`, `average` |
| `guardrail direction` | `increase_bad`, `decrease_bad` |

Prefer structured MCP input objects over shell-quoted JSON strings. Keep `primaryMetric` and `guardrails` as valid JSON strings only because the current FeatBit API stores those fields that way.
