---
name: project-sync
description: Sync release-decision experiment state to the web database. Provides the `sync.ts` CLI script that all other skills call to persist state changes (update fields, advance stage, log activities, manage experiment runs). Activate whenever a skill needs to write experiment state to the web DB. Triggers — "sync to web DB", "update experiment state", "push state", "set stage", "add activity", "create run", "start run", "analyze run", "decide run", "archive run", "record decision", "save learning", "get experiment".
license: Apache-2.0
metadata:
  author: FeatBit
  version: "2.0.0"
  category: release-management
---

# Project Sync — CLI Bridge to Web Database

This skill provides `sync.ts`, the CLI script that bridges agent skills to the web database.

All release-decision skills call this script to persist state changes. **No skill should construct HTTP requests or JSON payloads directly — always use `sync.ts`.**

---

## Script Location

**Always invoke with the absolute path** — the bash tool's cwd on sandbox0 VMs is `/workspace`, not the skill directory, so a relative `scripts/sync.ts` will fail with `Cannot find module`.

```bash
npx tsx $HOME/.claude/skills/project-sync/scripts/sync.ts <command> [args]
```

> All flag arguments require the `--` prefix (e.g. `--primaryMetric '{...}'`, never bare `primaryMetric '{...}'`). The script will reject or ignore bare-name pairs.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `SYNC_API_URL` | `https://www.featbit.ai` | Base URL of the web app |
| `ACCESS_TOKEN` | _(empty)_ | **Required.** Bearer token (`fbat_…`) sent as `Authorization` header. The web API validates this on every call to `/api/experiments/*` — requests without a valid, non-revoked, project-scoped token are rejected with 401/403. Issue a token from the web UI: `/data/env-settings` → **Agent tokens** → Issue token. |

Set `SYNC_API_URL` if the web app is not running at the default `https://www.featbit.ai`.

---

## Failure Modes

| Symptom | Cause | Action |
|---|---|---|
| `Unable to reach sync API` | Web app not running or wrong `SYNC_API_URL` | Start the web app; verify `SYNC_API_URL` |
| `ERROR 401` / `403` | Token required but missing or wrong | Set `ACCESS_TOKEN` env var |
| `Invalid stage: "..."` | Caller used a non-canonical stage value | Use only: `intent \| hypothesis \| implementing \| measuring \| learning` |
| `Invalid activity type` | Non-canonical `--type` value | Use only the values in the Canonical Enums table |
| Non-zero exit, no output | Network timeout or unexpected server crash | Check web app logs; retry once |

---

## Canonical Enums

These are the only valid values for each enum field. The script and server API **both** enforce them — using any other value will return an error.

| Field | Valid Values |
|---|---|
| `stage` | `intent` \| `hypothesis` \| `implementing` \| `measuring` \| `learning` |
| `activity type` | `stage_update` \| `field_update` \| `run_created` \| `run_collecting` \| `run_analyzing` \| `run_decided` \| `run_archived` \| `decision_recorded` \| `learning_captured` |
| `run status` | `draft` \| `collecting` \| `analyzing` \| `decided` \| `archived` — **NEVER use `running`, `paused`, `completed` or any other value.** Each status has its own dedicated CLI command — the command name *is* the status. |
| `method` | `bayesian_ab` \| `frequentist` \| `bandit` |
| `decision` | `CONTINUE` \| `PAUSE` \| `ROLLBACK` \| `INCONCLUSIVE` |
| `metricType` (run **and** state JSON) | `binary` \| `continuous` |
| `metricAgg` (run **and** state JSON) | `once` \| `count` \| `sum` \| `average` |
| `direction` (inside **state** `guardrails` JSON entry) | `increase_bad` \| `decrease_bad` |

> **Single canonical vocabulary.** Use the same `metricType` / `metricAgg` values
> for *both* run-column writes (`--primaryMetricType`, `--primaryMetricAgg`) and
> state-JSON writes (`--primaryMetric`, `--guardrails`). The legacy `numeric`
> spelling and the `last` aggregation are gone — use `continuous` and `count`
> (or `sum` / `average`) instead. The script accepts the legacy values on read
> for back-compat with old experiments but rejects them on write.

---

## Field Format Standards

| Field | Format | Example |
|---|---|---|
| `variants` (on project state) | Pipe-separated `"key (annotation)\|key (annotation)"` | `"standard (control)\|streamlined (treatment)"` |
| `primaryMetric` (on project state) | **JSON object** with `{name, event, metricType, metricAgg, description?}` — the web UI renders each field as its own column | `'{"name":"Signup conversion","event":"signup_completed","metricType":"binary","metricAgg":"once","description":"Proportion of visitors that complete a signup — chosen because it directly measures the H1 change."}'` |
| `guardrails` (on project state) | **JSON array** of `{name, event, metricType, metricAgg, direction, description?}` — one object per guardrail metric | `'[{"name":"Checkout abandonment","event":"checkout_abandoned","metricType":"binary","metricAgg":"once","direction":"increase_bad","description":"must not rise"},{"name":"Support load","event":"support_chat_open","metricType":"continuous","metricAgg":"count","direction":"increase_bad"}]'` |
| `guardrailEvents` (on run) | **Comma-separated** event names — sync.ts converts to JSON array | `"checkout_abandoned,support_chat_open"` |
| `inputData` | Valid JSON string — raw metrics snapshot | `'{"metrics":{"control":{"n":1000},"treatment":{"n":1020}}}'` |
| `analysisResult` | Valid JSON string — Bayesian output | `'{"decision":"CONTINUE","probability":0.87}'` |

---

## Commands

### get-experiment

Read full project state (includes experiment runs, activities, messages).

```bash
npx tsx $HOME/.claude/skills/project-sync/scripts/sync.ts get-experiment <experiment-id>
```

---

### update-state

Push one or more decision-state fields to the web DB.

```bash
npx tsx $HOME/.claude/skills/project-sync/scripts/sync.ts update-state <experiment-id> \
  --goal "..." \
  --intent "..." \
  --hypothesis "..." \
  --change "..." \
  --variants "standard (control)|streamlined (treatment)" \
  --primaryMetric '{"name":"Signup conversion","event":"signup_completed","metricType":"binary","metricAgg":"once","description":"Proportion of visitors that sign up."}' \
  --guardrails '[{"name":"Checkout abandonment","event":"checkout_abandoned","metricType":"binary","metricAgg":"once","direction":"increase_bad"}]' \
  --constraints "..." \
  --flagKey "my-flag-key"
```

**Allowed fields:** `goal`, `intent`, `hypothesis`, `change`, `variants`, `primaryMetric`, `guardrails`, `constraints`, `openQuestions`, `lastAction`, `lastLearning`, `flagKey`

> **variants format**: must be pipe-separated strings — NOT JSON. Use `"key (annotation)|key (annotation)"`.
>
> **primaryMetric format**: must be a valid JSON object with fields `name` (short display name), `event` (the instrumented event key, snake_case), `metricType` (`binary` or `continuous`), `metricAgg` (`once`, `count`, `sum`, or `average`), and optional `description` (rationale). The web UI renders `name`/`event`/`metricType`/`metricAgg` as separate table columns — do NOT dump the whole description into `name`.
>
> **guardrails format**: must be a valid JSON array; each entry is a guardrail object with the same shape as `primaryMetric` plus `direction` (`increase_bad` or `decrease_bad`). Use one entry per guardrail metric, never a single string.

---

### set-stage

Advance the project stage.

```bash
npx tsx $HOME/.claude/skills/project-sync/scripts/sync.ts set-stage <experiment-id> <stage>
```

**Valid stages:** `intent` | `hypothesis` | `implementing` | `measuring` | `learning`

---

### add-activity

Log an activity event.

```bash
npx tsx $HOME/.claude/skills/project-sync/scripts/sync.ts add-activity <experiment-id> --type <type> --title "..." [--detail "..."]
```

`--type` and `--title` are required. Use `--detail` for longer technical notes.

---

### create-run

Create a new experiment run (status starts as `draft`).

```bash
npx tsx $HOME/.claude/skills/project-sync/scripts/sync.ts create-run <experiment-id> <slug> \
  --hypothesis "Adding streamlined checkout will increase purchase_completed" \
  --method bayesian_ab \
  --primaryMetricEvent purchase_completed \
  --primaryMetricType binary \
  --primaryMetricAgg once \
  --controlVariant standard \
  --treatmentVariant streamlined \
  --guardrailEvents "checkout_abandoned,support_chat_open" \
  --minimumSample 1000 \
  --trafficPercent 100 \
  --priorProper false \
  --priorMean 0.1 \
  --priorStddev 0.05 \
  --observationStart 2024-01-15T00:00:00Z \
  --observationEnd 2024-01-29T00:00:00Z
```

`guardrailEvents` accepts comma-separated event names — sync.ts converts them to a JSON array for storage.

---

### Run status transitions

One command per status — **never pass a status string**; pick the command that matches the target state. There is intentionally no generic `set-run-status` command.

| Command | Writes status |
|---|---|
| `start-run <experiment-id> <slug>` | `collecting` |
| `analyze-run <experiment-id> <slug>` | `analyzing` |
| `decide-run <experiment-id> <slug>` | `decided` |
| `archive-run <experiment-id> <slug>` | `archived` |

```bash
# Begin collecting data for an existing draft run
npx tsx $HOME/.claude/skills/project-sync/scripts/sync.ts start-run <experiment-id> <slug>

# Move to the analysis phase
npx tsx $HOME/.claude/skills/project-sync/scripts/sync.ts analyze-run <experiment-id> <slug>

# Record that a decision has been reached
npx tsx $HOME/.claude/skills/project-sync/scripts/sync.ts decide-run <experiment-id> <slug>

# Archive a run that is no longer in play
npx tsx $HOME/.claude/skills/project-sync/scripts/sync.ts archive-run <experiment-id> <slug>
```

---

### save-input

Save the raw metrics snapshot collected for this run.

```bash
npx tsx $HOME/.claude/skills/project-sync/scripts/sync.ts save-input <experiment-id> <slug> \
  --inputData '{"metrics":{"control":{"n":1000,"conversions":87},"treatment":{"n":1020,"conversions":104}}}'
```

`--inputData` must be a valid JSON string.

---

### save-result

Save the Bayesian analysis output for this run.

```bash
npx tsx $HOME/.claude/skills/project-sync/scripts/sync.ts save-result <experiment-id> <slug> \
  --analysisResult '{"decision":"CONTINUE","probability":0.87,"rope":{"low":0.0,"high":0.01}}'
```

`--analysisResult` must be a valid JSON string.

---

### record-decision

Record the human/agent decision for this run.

```bash
npx tsx $HOME/.claude/skills/project-sync/scripts/sync.ts record-decision <experiment-id> <slug> \
  --decision CONTINUE \
  --decisionSummary "Roll out streamlined checkout to 100% of users" \
  --decisionReason "Treatment shows 87% probability of beating control; ROPE analysis clear"
```

`--decision` must be one of: `CONTINUE | PAUSE | ROLLBACK | INCONCLUSIVE`  
`--decisionSummary` is required (plain-language recommended action).  
`--decisionReason` is optional (technical rationale).

---

### save-learning

Capture structured learnings at the end of a cycle.

```bash
npx tsx $HOME/.claude/skills/project-sync/scripts/sync.ts save-learning <experiment-id> <slug> \
  --whatChanged "Reduced checkout to 2 steps" \
  --whatHappened "Conversion increased by +2.3pp (p=0.87 Bayesian)" \
  --confirmedOrRefuted "confirmed" \
  --whyItHappened "Fewer steps reduced abandonment friction" \
  --nextHypothesis "A payment-method pre-fill will further reduce drop-off"
```

At least one learning field is required. All five fields are strongly recommended.

---

## Standard Write Pattern Per Stage Transition

Every stage transition follows this write sequence:

```bash
# 1. Push the fields produced in this stage
npx tsx $HOME/.claude/skills/project-sync/scripts/sync.ts update-state <experiment-id> --hypothesis "..."

# 2. Advance stage
npx tsx $HOME/.claude/skills/project-sync/scripts/sync.ts set-stage <experiment-id> <next-stage>

# 3. Log the transition
npx tsx $HOME/.claude/skills/project-sync/scripts/sync.ts add-activity <experiment-id> --type stage_update --title "Moved to <next-stage>"
```

When starting an experiment run:

```bash
# 4a. Create the run (draft)
npx tsx $HOME/.claude/skills/project-sync/scripts/sync.ts create-run <experiment-id> <slug> --method bayesian_ab ...

# 4b. Activate it
npx tsx $HOME/.claude/skills/project-sync/scripts/sync.ts start-run <experiment-id> <slug>

npx tsx $HOME/.claude/skills/project-sync/scripts/sync.ts add-activity <experiment-id> --type run_collecting --title "Run <slug> started"
```

When recording a decision:

```bash
npx tsx $HOME/.claude/skills/project-sync/scripts/sync.ts record-decision <experiment-id> <slug> --decision CONTINUE --decisionSummary "..."
npx tsx $HOME/.claude/skills/project-sync/scripts/sync.ts decide-run <experiment-id> <slug>
npx tsx $HOME/.claude/skills/project-sync/scripts/sync.ts add-activity <experiment-id> --type decision_recorded --title "Decision: CONTINUE"
```

---

## Architecture

```
Agent skill → project-sync → npx tsx sync.ts <command> → HTTP API → Prisma → PostgreSQL → Web UI
```

- The web database (via API + Prisma) is the canonical source for all project state.
- Skills pass simple string arguments — no JSON construction needed.
- The script validates all enums and formats before making any HTTP calls.

---

## Execution Procedure

```python
def persist_stage_transition(experiment_id, fields, stage, activity_type, activity_title):
    # All three writes are required. Do not skip any step.
    assert Skill("project-sync", f'update-state {experiment_id} {fields}').ok
    assert Skill("project-sync", f"set-stage {experiment_id} {stage}").ok
    assert Skill("project-sync", f'add-activity {experiment_id} --type {activity_type} --title "{activity_title}"').ok
```

**Invocation model:** All satellite skills call this skill via `Skill("project-sync", "<command> <args>")`. They never construct raw HTTP requests. The three-step pattern above is the minimum contract for every stage transition.

## Signal Inference

| Command tier | When to use |
|---|---|
| **Project-level** (`update-state`, `set-stage`, `add-activity`, `get-experiment`) | Every stage transition in every satellite skill |
| **Run-level** (`create-run`, `start-run`, `analyze-run`, `decide-run`, `archive-run`, `save-input`, `save-result`, `record-decision`, `save-learning`) | Only when an experiment run is being created, advanced, or closed |

Auth: if `ACCESS_TOKEN` is set in the connector's shell environment, every HTTP request includes `Authorization: Bearer <token>`. The web API validates the token hash, checks that it is not revoked, and (for experiment routes) verifies that the token's `projectKey` matches the experiment's project. A missing or revoked token returns 401; a wrong-project token returns 403.
