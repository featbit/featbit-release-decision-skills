---
name: experiment-workspace
description: Creates and manages experiments as database-backed records — the unified replacement for an online A/B test dashboard. Activate when user is ready to start collecting data for a hypothesis, wants to set up an experiment, needs to pull or organize experiment data, wants to run analysis calculations, or asks "how do I track this experiment", "set up the experiment", "run the analysis", "pull results", "compute the stats". Sits between measurement-design (instrumentation confirmed) and evidence-analysis (results interpreted). Do not use before a hypothesis and primary metric exist.
license: Apache-2.0
metadata:
  author: FeatBit
  version: "2.0.0"
  category: release-management
---

# Experiment Workspace

This skill manages the full experiment lifecycle through the database.

It replaces what an online experiment dashboard does — experiment creation, data collection tracking, analysis computation, and result storage — with database records accessible via HTTP API. All data flows through a single PostgreSQL database shared by the web UI, sandbox agent, and analysis scripts.

The database is the experiment. The script is the dashboard.

---

## When to Activate

- Hypothesis exists, primary metric is defined, instrumentation is confirmed (came from `measurement-design`)
- User wants to "start the experiment" — create the tracking structure
- User wants to pull data and run analysis
- User wants to check whether enough data has accumulated
- User wants to archive a completed experiment result
- Project stage is `measuring`

Do not activate if:
- Hypothesis is not yet written → go to `hypothesis-design`
- Primary metric is undefined → go to `measurement-design`
- Data already exists and the user only wants a decision → go to `evidence-analysis` directly

## On Entry — Read Current State

Before doing any work, read the project from the database using the `project-sync` skill's `get-experiment` command.

Check these fields:

| Field | Purpose |
|---|---|
| `hypothesis` | The causal claim being tested |
| `primaryMetric` | What is being measured |
| `stage` | Current lifecycle position |
| `experiments` | Existing experiment records and their status |

- If `hypothesis` is empty → redirect to `hypothesis-design`
- If `primaryMetric` is empty → redirect to `measurement-design`
- If an experiment already exists for this hypothesis → resume from its current status rather than creating a new one

---

## What This Skill Manages

### Database Records (Experiment model)

Each experiment is stored as a row in the `Experiment` table (Prisma schema). Key fields:

| DB Field | Purpose |
|---|---|
| `slug` | Experiment identifier (kebab-case) |
| `hypothesis` | The causal claim being tested |
| `primaryMetricEvent` | Event name for the primary metric |
| `guardrailEvents` | JSON array string of guardrail event names |
| `controlVariant` / `treatmentVariant` | Variant values |
| `minimumSample` | Validity floor per variant |
| `observationStart` / `observationEnd` | Observation window |
| `priorProper` / `priorMean` / `priorStddev` | Prior configuration |
| `inputData` | Collected metric data (JSON string) |
| `analysisResult` | Computed analysis output (JSON string) |
| `trafficPercent` | Bucket width — percentage of hash space allocated (1–100, default 100) |
| `trafficOffset` | Bucket start — hash-space offset for mutual-exclusion splits (0–99, default 0) |
| `layerId` | Optional filter tag — restricts exposure query to evaluations with matching `layer_id`. Does **not** create independent random assignment; leave null in normal operation |
| `audienceFilters` | JSON array of audience filter rules (see experiment-folder-spec.md) |
| `method` | Analysis method: `bayesian_ab` (default, balanced sampling) or `bandit` (pass-through, asymmetric) |
| `status` | `draft` / `collecting` / `analyzing` / `decided` / `archived` — **NEVER use `"completed"`, `"finished"`, `"closed"`, or any other value not in this list.** `"completed"` is a `Project.sandboxStatus` value and does NOT apply to experiments. |
| `decision` / `decisionSummary` / `decisionReason` | Final decision (summary = plain-language action, reason = technical rationale) |

### Scripts

```
skills/experiment-workspace/scripts/
  analyze.ts             ← agent's entry point: triggers the web /analyze endpoint
```

The real statistical work lives on the server: the web app's `POST /api/experiments/:id/analyze` endpoint queries `track-service` for the latest metrics and runs the Bayesian or Bandit algorithm (selected automatically from the run's `method` field), then writes both `inputData` and `analysisResult` back to the run record in one round-trip. `analyze.ts` is a thin wrapper that the agent calls so SKILL.md and references never need raw curl.

**Two experiment methods** (set via `method` field, configurable in web UI):
- **bayesian_ab (default)**: Balanced sampling — the data server caps each variant at MIN(count) so both arms have equal N, eliminating SRM noise. One-shot analysis.
- **bandit**: Pass-through — asymmetric allocation is intentional (Thompson Sampling shifts traffic toward the winning arm). No balanced sampling applied.

The web `/analyze` route picks the algorithm automatically from the run's `method` field.

**Key principle: Flag traffic ≠ Experiment traffic.** Developers instrument once (`variation()` + `track()`), never per-experiment. The PM configures experiment scope (traffic%, offset, audience, method) post-hoc via the web UI. The data server applies these filters at query time — the flag itself is unaware of the experiment.

All experiment data lives in the shared PostgreSQL database, accessible via the web app's HTTP API (`SYNC_API_URL`, default `https://www.featbit.ai`). No local experiment files needed — the web UI, sandbox agent, and scripts all read/write the same database.

---

## Decision Actions

### "First time setup"

1. The web app must be running — it exposes both the state API (`/api/experiments/*`) and the analysis endpoint (`/api/experiments/:id/analyze`).
2. `track-service` must be running and receiving `flag_evaluation` + metric events from your instrumentation. Analysis reads straight from ClickHouse via track-service — no local `inputData` population step is needed.
3. No Python or numpy/scipy install required on the agent side — analysis runs server-side inside the web app.

### Expert-mode experiments (pre-pasted data, no flag wired)

When `entryMode === "expert"` and a run already has `inputData` populated via the web wizard, the analysis endpoint does **not** need `flagKey` or `featbitEnvId`. The endpoint automatically uses the stored `inputData` when the live track-service fetch isn't possible or a flag isn't wired. Key behaviors to remember:

- Don't ask the user to paste data or configure a FeatBit flag before analyzing — the wizard already did the equivalent.
- The analyze response includes `dataSource: "live" | "stored"` — read it and mention it when explaining results ("numbers came from your pasted data" vs "fresh from track-service").
- `inputData` is the canonical record of what the user entered: parse it to confirm numbers back to them when they ask "did you get my data?"

---

### "I want to start an experiment"

1. Confirm the hypothesis slug — derive from the flag key, e.g. `chat-cta-v2`
2. Ensure the web app is running (scripts need the HTTP API)
3. Persist the experiment to the database using the `project-sync` skill's `create-run` then `start-run` commands (see Persist State section below)
4. Copy `hypothesis:` verbatim from the project state read on entry
5. Confirm the `observation_window.start` date — this is today if the flag was just enabled
6. Set `minimum_sample_per_variant` using the following fallback chain. Do not expose the formula to the user at any step.

   **Step 1 — read the hypothesis from project state (loaded on entry):**
   - Does it mention a current baseline rate? (e.g. "increase signup rate from 4% to 5%" → p_baseline = 0.04)
   - Does it mention an expected lift that implies a current level? Extract the number and compute `ceil(30 / p_baseline)`

   **Step 2 — infer from metric event name and funnel stage:**
   - Re-read the primary metric event name: does it suggest a funnel position?
   - Use these heuristics as a starting estimate:

     | Metric type | Typical baseline range | Suggested floor |
     |-------------|----------------------|-----------------|
     | Button click / CTA | 3–10% | 500 |
     | Signup / registration | 1–5% | 1,000 |
     | Purchase / checkout | 1–3% | 1,500 |
     | Feature engagement (active users) | 10–30% | 200 |
     | Error rate / latency (inverse) | 1–5% | 1,000 |

   **Step 3 — collect a short baseline sample from the control group (most accurate):**
   - If the flag has been live for at least 1–3 days, guide the user to pull control-only data for that period and share it with the agent.
   - Tell the user exactly what numbers are needed:
     > "To get an accurate baseline, I need two numbers from your control group for the past few days:
     > - **n** — how many unique users were exposed to the control variant
     > - **k** — how many of those users triggered the '[metric event]' event
     > You can get these from FeatBit's experiment results, your database, or your analytics tool."
   - Once the user provides `n` and `k`: compute `p_baseline = k / n`, then set `ceil(30 / p_baseline)` — this overrides any estimate from Steps 1–2

   **Step 4 — ask the user only if Steps 1–3 all fail:**
   "What is the current conversion rate for [metric name]? A rough estimate is fine, e.g. 'about 5%' or 'maybe 1 in 20 users'."

   **Step 5 — if no estimate is available from any source:**
   - Use 1,000 as a safe conservative default (assumes ~3% baseline)
   - Record the assumption explicitly in the experiment record so it can be revised once real data arrives
7. Ask the user whether they have prior knowledge about the expected lift for this metric:
   - "Do you have results from a similar past experiment? If so, what was the approximate lift and how uncertain was it?"
   - If the user provides a past `μ_rel` and `se` (or a rough range): set `priorProper: true`, `priorMean: <μ_rel>`, `priorStddev: <se>` in the experiment
   - If the user ran a pilot phase (separate experiment window) and has its `analysisResult`: read `μ_rel` and `se` from it and use those as the prior — but only if the pilot data will **not** be included in the new experiment's `inputData`
   - If no prior knowledge is available: set `priorProper: false` (flat prior, the safe default)
8. Persist state to the database (see Persist State section below)
9. Tell the user: once the flag is emitting `flag_evaluation` events and the metric event is firing via your instrumentation, track-service will accumulate data automatically; open the experiment's Full Analysis tab when ready to see results

The agent does not need to touch any online dashboard. Persisting the experiment record to the database is the equivalent of "creating an experiment".

### "I want to check if we have enough data"

1. Trigger a fresh analysis — this makes the web app query track-service for the latest metrics:
   ```bash
   npx tsx $HOME/.claude/skills/experiment-workspace/scripts/analyze.ts <experiment-id> <run-id>
   ```
   The response contains either the analysis result, `{ "status": "no_data" }` (nothing in ClickHouse yet), or `{ "status": "no_data", "reason": "zero_users" }` (metric event present but no users).
2. If `no_data`: instrumentation hasn't fired yet. Confirm with the user that `flag_evaluation` and the primary metric event are being sent with the correct `env_id` and `flag_key`.
3. If data is returned, check the total `n` across variants against the run's `minimumSample`. Below minimum → wait and re-check later. Above minimum → proceed to interpret the analysis.

### "I want to run the analysis"

1. Trigger the web app's analyze endpoint — it queries track-service for fresh metrics, runs the Bayesian algorithm, and writes both `inputData` and `analysisResult` back to the run record:
   ```bash
   npx tsx $HOME/.claude/skills/experiment-workspace/scripts/analyze.ts <experiment-id> <run-id>
   ```
   Alternatively, opening the experiment's **Full Analysis** tab in the web UI auto-triggers the same call.
2. Read the result back via `project-sync get-experiment <experiment-id>` and inspect the matching run's `analysisResult`.
3. Key outputs to check before handing off:
   - **P(win)** ≥ 95% → strong signal; ≤ 5% → likely harmful; 20–80% → inconclusive
   - **risk[trt]** — if P(win) is near a boundary, this tells you how costly a wrong call is
   - **SRM check** — if χ² p-value < 0.01, stop and investigate traffic split before interpreting metrics
4. Hand off to `evidence-analysis` with the run's `analysisResult` and definition fields.
5. Persist experiment status to the database (see Persist State section below).

For the full list of metric types and usage patterns (proportion, continuous, inverse, multiple arms, informative prior), see `references/analysis-bayesian.md`.

**Multi-arm threshold reminder:** if the experiment has more than 2 variants (A/B/C/n), raise the P(win) threshold to compensate for multiple comparisons:

| Arms compared | Suggested threshold |
|--------------|-------------------|
| 2 | 95% |
| 3 | 98.3% |
| 5 | 99% |

See `references/analysis-bayesian.md` → "On Family-wise Error" for details.

### "I want to update the data and re-run"

1. Re-run analysis (or click **Refresh Latest Analysis** in the UI). The web app re-queries track-service and re-runs the algorithm; both `inputData` and `analysisResult` are overwritten idempotently:
   ```bash
   npx tsx $HOME/.claude/skills/experiment-workspace/scripts/analyze.ts <experiment-id> <run-id>
   ```
2. Read the refreshed result via `get-experiment` and continue interpretation.
3. Persist updated experiment status to the database (see Persist State section below).

### "I want to run a Bandit experiment"

A bandit experiment replaces fixed 50/50 traffic with dynamic reweighting. It requires a continuous cycle of data collection → weight computation → FeatBit flag update.

**Setup** (same as A/B — uses the same experiment record in the DB):
1. Create the experiment record following the standard workflow (see "I want to start an experiment")
2. Choose `primaryMetricEvent` — bandit optimizes this single metric
3. Note: bandit works best for proportion metrics (conversion rate, CTR)

**Each reweighting cycle** (recommended every 6–24 hours):
1. Trigger a fresh analysis via the web app (it picks bandit automatically from the run's `method` field):
   ```bash
   npx tsx $HOME/.claude/skills/experiment-workspace/scripts/analyze.ts <experiment-id> <run-id>
   ```
2. Read `analysisResult` from the run record via `get-experiment`:
   - If `enough_units: false` → burn-in not complete, do not apply weights yet (need ≥ 100 users per arm)
   - If `srm_p_value < 0.01` → SRM detected, investigate traffic split before applying weights
   - Otherwise → apply `bandit_weights` to the FeatBit feature flag via API
4. Update FeatBit feature flag rollout weights using the FeatBit API (see `references/analysis-bandit.md` for the conversion formula)

**Stopping condition**: when `best_arm_probabilities[arm] >= 0.95` for any arm, stop reweighting.

**After stopping — transition to final analysis**:
1. Set winning arm to 100% in FeatBit
2. Switch the run's `method` field to `bayesian_ab` (via the web UI experiment settings) and trigger a final analysis:
   ```bash
   npx tsx $HOME/.claude/skills/experiment-workspace/scripts/analyze.ts <experiment-id> <run-id>
   ```
3. Hand off to `evidence-analysis` with the experiment record containing:
   - `analysisResult` (final Bayesian result — note: δ estimate may have wider uncertainty due to unequal traffic)
   - Previous bandit `analysisResult` (final `best_arm_probabilities` — most reliable decision signal)
   - Experiment definition fields from the DB

For full details on output interpretation and FeatBit API integration, see `references/analysis-bandit.md`.

### "I want to track long-term effects after launch"

A/B and Bandit experiments measure short-term behavior. Transient effects — novelty, seasonal spikes, event-driven traffic — can inflate results during the experiment window. A holdout group validates whether the effect persists over months.

1. After full launch, adjust the feature flag traffic split to 95/5 — keep 5% of users on the old variant
2. Record the holdout plan in the experiment record (e.g. in a note or dedicated field):
   - `holdout percentage: 5%`
   - `check_at_days: [30, 60, 90]`
   - `launched_at: <launch date>`
3. At each checkpoint (day 30, 60, 90):
   - Create a new run with a time-stamped slug (e.g. `<slug>-holdout-30d`) via `project-sync create-run`
   - Trigger analysis on that run — the web app pulls fresh data from track-service and writes both `inputData` and `analysisResult`:
     ```bash
     npx tsx $HOME/.claude/skills/experiment-workspace/scripts/analyze.ts <experiment-id> <holdout-run-id>
     ```
4. Compare P(win) and rel Δ across checkpoints — look for stability, decay, or growth
5. When holdout analysis is complete, remove the holdout split from the feature flag

For full interpretation guidance (three patterns: holds / decays / improves), see `references/analysis-holdout.md`.

### "I want to close the experiment"

1. Set experiment status to `decided` and record `observationEnd`, `decision`, `decisionSummary`, `decisionReason` in the DB
2. Persist experiment closure to the database (see Persist State section below)
3. Hand off to `learning-capture`

---

## Operating Rules

- The experiment record in the database is the contract. Do not change `primaryMetricEvent`, `controlVariant`, or `treatmentVariant` after data collection starts — it would invalidate the data already collected.
- `observationStart` must match when the flag was actually enabled. Do not backfill earlier — pre-flag data is not part of the experiment.
- After the web `/analyze` endpoint runs, verify the `inputData` it wrote is sane: `k` ≤ `n` for every row, variant keys match the experiment record, no zero `n` values.
- Do not interpret results by eyeballing `inputData`. Always let the web `/analyze` endpoint compute `analysisResult` and read from there.
- **NEVER compute analysis statistics inline and write the result directly to `analysisResult`.** The web UI renderer expects the exact JSON schema produced by the `/analyze` endpoint's server-side algorithms. If data is provided manually (e.g. the user tells you "300 users, 13 conversions"), don't inline it — that data is not in track-service, so `/analyze` can't use it and inline synthesis will produce JSON the UI cannot render. Instead, confirm with the user how to backfill the events into track-service, then run `/analyze`.
- If the SRM check flags an imbalance (χ² p < 0.01), do not proceed to `evidence-analysis` — the data is unreliable.
- "97% confidence in the result" does not mean "ship it." That is `evidence-analysis`'s job.
- **Valid `status` values are: `draft`, `collecting`, `analyzing`, `decided`, `archived` — nothing else.** Do not use `"completed"`, `"finished"`, `"closed"`, or any invented terminal state. `"completed"` belongs to `Project.sandboxStatus`, not `Experiment.status`. Writing an invalid status will break the `ExperimentWorker` polling query.

### Persist State

After completing work, use the `project-sync` skill to persist state to the database. The specific commands depend on the action performed:

**Starting an experiment:**

Extraction rule: `primaryMetricEvent` = left token of `primaryMetric` split on ` — `.  
Example: `"purchase_completed — north star metric …"` → `primaryMetricEvent = "purchase_completed"`.

```python
assert Skill("project-sync", f'create-run {experiment_id} {slug} --hypothesis "{hypothesis}" --method bayesian_ab --primaryMetricEvent "{primary_metric_event}" --primaryMetricType binary --primaryMetricAgg once --controlVariant "{control}" --treatmentVariant "{treatment}" --guardrailEvents "{guardrail_csv}" --minimumSample {n} --trafficPercent 100 --priorProper false --priorMean 0.1 --priorStddev 0.05 --observationStart {today}').ok
assert Skill("project-sync", f"start-run {experiment_id} {slug}").ok
assert Skill("project-sync", f'update-state {experiment_id} --lastAction "Created experiment {slug}"').ok
assert Skill("project-sync", f"set-stage {experiment_id} measuring").ok
assert Skill("project-sync", f'add-activity {experiment_id} --type stage_update --title "Experiment {slug} created"').ok
```

**Running / re-running analysis:**  
`analyze.ts` calls the web `/analyze` endpoint which writes `inputData` and `analysisResult` automatically. Then:
```python
assert Skill("project-sync", f"analyze-run {experiment_id} {slug}").ok
```

**Closing an experiment:**
```python
assert Skill("project-sync", f"decide-run {experiment_id} {slug}").ok
assert Skill("project-sync", f'update-state {experiment_id} --lastAction "Experiment {slug} closed"').ok
```

---

## Handoff Chain

```
measurement-design
  → experiment-workspace   ← this skill
      → evidence-analysis
          → learning-capture
```

When handing off to `evidence-analysis`, pass the experiment's `analysisResult` and definition fields (hypothesis, primaryMetricEvent, variants, etc.) so the decision can be tied back to the hypothesis.

---

## Execution Procedure

```python
def manage_experiment(project_id, user_message):
    state = Skill("project-sync", f"get-experiment {project_id}")
    if state.hypothesis in ("", None):
        Skill("hypothesis-design", project_id); return
    if state.primaryMetric in ("", None):
        Skill("measurement-design", project_id); return
    intent = classify_intent(user_message)
    # "create" → create-run + start-run path (see Persist State / Starting an experiment)
    # "reanalyze" → analyze.ts + analyze-run path
    # "bandit" → analyze.ts + bandit reweighting cycle
    # "holdout" → create holdout run with time-stamped slug
    # "close" → decide-run + hand off to learning-capture
    execute_intent(intent, project_id, state)
```

## Signal Inference

| Check | Rule |
|---|---|
| `hypothesis` or `primaryMetric` empty | Redirect upstream before doing any experiment work |
| Run already exists for this hypothesis | Resume from its current status; do not create a duplicate |
| `no_data` from analyze endpoint | Instrumentation hasn't fired yet — confirm `flag_evaluation` + metric event are being sent |
| n < `minimumSample` | Wait; do not interpret results |
| SRM p < 0.01 | Stop; fix traffic split before handing off to `evidence-analysis` |
| Bandit: `enough_units: false` | Burn-in not complete; do not apply weights yet |
| User provides raw numbers manually | Do not inline-compute `analysisResult` — the web UI renderer expects the server schema |

## Reference Files

- [references/experiment-folder-spec.md](references/experiment-folder-spec.md) — DB schema reference, experiment fields, `inputData` format, `analysisResult` JSON examples
- [references/analysis-bayesian.md](references/analysis-bayesian.md) — Bayesian A/B algorithm: posterior math, outputs, `minimumSample` floor
- [references/analysis-bayesian-usage-patterns.md](references/analysis-bayesian-usage-patterns.md) — proportion, continuous, inverse, multi-arm, informative prior, primary+guardrails patterns
- [references/analysis-bayesian-decision-guide.md](references/analysis-bayesian-decision-guide.md) — decision table, observation window, SRM investigation, sequential testing, FWE
- [references/analysis-bandit.md](references/analysis-bandit.md) — Bandit analysis: Thompson Sampling, `analysisResult` fields, FeatBit API integration, stopping condition
- [references/analysis-holdout.md](references/analysis-holdout.md) — Holdout group: post-launch long-term validation, three effect patterns, checkpoint cadence
- [references/data-source-guide.md](references/data-source-guide.md) — track-service query endpoint, `ExperimentQueryRequest`/`ExperimentQueryResponse` shapes, canonical data flow

**Agent-facing script:**

- [scripts/analyze.ts](scripts/analyze.ts) — trigger the web app's `/api/experiments/:id/analyze` endpoint for a run
