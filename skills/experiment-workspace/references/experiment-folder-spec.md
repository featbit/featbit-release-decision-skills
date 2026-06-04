---
name: Experiment Data Spec
description: DB schema reference for ExperimentRun fields, inputData format, analysisResult JSON examples, and field format standards.
---

# Experiment Data Spec

Every experiment is a row in the `Experiment` table (Prisma schema), accessed via HTTP API.
The database is the experiment. No local experiment files needed.

---

## Database Schema (Experiment model)

| Field | Type | Purpose |
|---|---|---|
| `id` | String (cuid) | Primary key |
| `slug` | String | Experiment identifier (kebab-case), unique within a project |
| `hypothesis` | String? | The causal claim being tested |
| `primaryMetricEvent` | String? | Event name for the primary metric |
| `guardrailEvents` | String? | JSON array string of guardrail event names |
| `controlVariant` | String? | Control variant value (e.g. "false", "baseline") |
| `treatmentVariant` | String? | Treatment variant value (e.g. "true", "candidate") |
| `minimumSample` | Int? | Validity floor per variant (see SKILL.md for computation) |
| `observationStart` | String? | ISO 8601 date when the flag was enabled |
| `observationEnd` | String? | ISO 8601 date when observation ended (null if still running) |
| `priorProper` | Boolean (false) | Whether an informative prior is used |
| `priorMean` | Float? | Expected relative lift (0 = no expected direction) |
| `priorStddev` | Float? | Uncertainty around prior mean (0.3 = ±30% plausible range) |
| `trafficPercent` | Float (100) | Bucket width — percentage of hash space this experiment occupies (1–100). Combined with `trafficOffset` for non-overlapping splits |
| `trafficOffset` | Int (0) | Bucket start — offset into the [0,100) hash space. The experiment occupies [offset, offset+percent). Must satisfy offset+percent ≤ 100 |
| `layerId` | String? | Optional filter tag. When set, the data server adds `AND layer_id = $4` to the exposure query — filtering to evaluations tagged with this ID at SDK track time. Does **not** create an independent hash space; two experiments with the same `flagKey` but different `layerId` still share the same hash-based bucket assignment |
| `audienceFilters` | String? | JSON array of audience filter rules. Each entry: `{"property":"<user_prop>","op":"eq|neq|in|nin","value":"..."}` or `{"property":"...","op":"in|nin","values":["a","b"]}`. Null = all users eligible. The data server applies these filters when querying exposure+conversion data |
| `method` | String? | Analysis method: `bayesian_ab` (default) or `bandit`. Controls how the data server samples exposure data. See Balanced Sampling section below |
| `inputData` | String? | Collected metric data (JSON string — see format below) |
| `analysisResult` | String? | Computed analysis output (JSON string — see format below) |
| `status` | String ("draft") | `draft` / `collecting` / `analyzing` / `decided` |
| `decision` | String? | Final decision category |
| `decisionSummary` | String? | Plain-language action recommendation for non-technical readers |
| `decisionReason` | String? | Technical rationale with data points |
| `createdAt` | DateTime | Auto-generated |
| `updatedAt` | DateTime | Auto-updated |

Rules for experiment fields:
- `slug` must be unique within the project — typically derived from the flag key (e.g. `chat-cta-v2`)
- `primaryMetricEvent` must exactly match the event name tracked via FeatBit SDK's `track()` call
- `observationStart` is the date from which logs are included — do not backfill before the flag was enabled
- `minimumSample` is a sanity floor, not a stopping rule
- `priorProper: false` (default) = flat prior; `priorProper: true` = informative Gaussian prior
- Do not change `primaryMetricEvent`, `controlVariant`, or `treatmentVariant` after data collection starts
- `trafficPercent` defaults to 100 (all eligible traffic). The data server hashes `user_key || flagKey`, mods 100, and checks that the result falls within `[trafficOffset, trafficOffset + trafficPercent)`. When percent is 100, hash-based sampling is skipped entirely.
- `trafficOffset` defaults to 0. For non-overlapping traffic splits, assign each experiment a contiguous range: e.g. Experiment A offset=0/percent=50 ([0,50)), Experiment B offset=50/percent=50 ([50,100)). Ensure offset + percent ≤ 100.
- `layerId` is a WHERE-clause filter on `flag_evaluations.layer_id`, not a hash salt. It lets you restrict which logged evaluations are included (e.g., only evaluations made inside a specific product layer or surface). It does **not** produce independent random assignment — two experiments with the same `flagKey` but different `layerId` still derive their bucket positions from `hashtext(user_key || flagKey)`. True independent assignment (layering / orthogonal) requires a different `flagKey`, which means a different project. Leave null for sequential experiments.
- `audienceFilters` applies server-side filtering on `user_props` when querying exposure and conversion data. Supported operators: `eq` (equals), `neq` (not equals), `in` (one of), `nin` (none of). Filters are AND-combined. Can be edited from the web UI at any time; changes only affect future queries, not historical data.

### Balanced Sampling (method-conditional)

The `method` field controls how the data server processes exposure data before analysis:

- **`bayesian_ab`** (default): **Balanced sampling** — after collecting first-exposure rows, the data server ranks users within each variant by `ABS(hashtext(user_key))` and caps each variant at `MIN(count per variant)`. This ensures equal N across all arms, eliminating SRM (Sample Ratio Mismatch) noise from natural traffic imbalance. The hash-based ordering is deterministic — the same users are always selected.

- **`bandit`**: **Pass-through** — no balanced sampling. Asymmetric allocation across variants is intentional (Thompson Sampling dynamically shifts traffic toward the winning arm). All first-exposure users are included in the analysis as-is.

This is applied at the data server layer (both .NET `MetricCollector` and TypeScript `featbit.ts` adapter). The analysis scripts receive already-balanced data and do not need to account for unequal sample sizes in `bayesian_ab` mode.

---

## How Traffic Allocation Actually Works

Understanding what `trafficPercent` / `trafficOffset` actually filter helps avoid architecture mistakes.

### Data source: `flag_evaluations` mirrors the flag

Every row in `flag_evaluations` is a copy of a real flag evaluation — the variant field holds exactly what FeatBit served to that user. The experimentation data server never re-assigns variants; it queries this table to count exposures and conversions. If the flag is 50/50, the table accumulates ~50% each. If the flag is 20/80, the table accumulates ~20% / ~80%.

### Hash filter is a second independent filter

When `trafficPercent < 100`, the data server applies:
```sql
abs(hashtext(user_key || flagKey)) % 100 >= trafficOffset
AND abs(hashtext(user_key || flagKey)) % 100 < trafficOffset + trafficPercent
```
This hash is **independent** of FeatBit's own flag-evaluation hash. Selecting users in bucket `[0, 30%)` does not change the variant ratio — you get approximately the same variant proportions as the full set.

### Flag split inheritance

| Scenario | Effective experiment sample |
|---|---|
| Flag 50/50, `trafficPercent=100` (default) | Hash filter skipped entirely — all evaluations included; bayesian trims to equal N |
| Flag 50/50, `trafficPercent=50, offset=0` | Half the users; still ~50/50 within the window |
| Flag 20/80, `trafficPercent=100` | All evaluations included; bayesian trims both groups to ~20% of total |
| Flag 20/80, `trafficPercent=30, offset=0` | ~6% total as variant A, ~24% as variant B; bayesian trims both to ~6% |

### Gradual rollout and unequal flag splits are intentional

An unequal variant split (e.g., 10% treatment / 90% control) is not a misconfiguration — it is a deliberate risk-control decision: the product team limits exposure to the new experience until the experiment validates it. The correct response is **not** to change the flag split to 50/50; doing so defeats the purpose of gradual rollout.

The three layers of traffic control are independent and each serves a different purpose:

| Layer | Who decides | Purpose |
|---|---|---|
| **Flag split** (e.g., 20/80) | Product / ops | Risk control — how many users see the new experience |
| **`trafficPercent` / `trafficOffset`** | Experiment design | Isolation — carve a sub-pool from the already-exposed users for mutual exclusion between concurrent experiments |
| **Bayesian balanced sampling** | Data server (automatic) | Statistical fairness — trim both groups to equal N, eliminating SRM noise |

**Practical consequence of a small treatment group:** The treatment-side N is the population ceiling. A 10% rollout means you need to wait longer for sufficient N than a 50% rollout. `minimumSample` should be set conservatively, and the observation window planned accordingly. Running mutual-exclusion experiments on top of a small rollout further reduces each experiment's sub-pool — accept a longer timeline or run sequentially.

**When an unequal split IS a problem:** If someone accidentally sets the flag to 2/98 while intending 50/50, bayesian balanced sampling will trim both groups to 2% of total — discarding 98% of control-side data. In that case, fix the flag configuration, not the experiment parameters.

### One `flagKey` = one hash space = one project constraint

```
One flagKey / one project
  ├── Concurrent max?      → N mutually exclusive experiments (non-overlapping bucket ranges)
  ├── Cannot do?           → Independent layering / orthogonal (requires different flagKey)
  ├── Recommended form?    → One experiment + primary metric + guardrails
  └── Multiple experiments? → Sequential iteration (Exp1 decides → Exp2 inherits learning)
```

For **orthogonal** experiments (same user in two independent experiments simultaneously) or **true layering** (independent random assignment per layer), each experiment layer needs its own hash seed — which in this system means a different `flagKey`, therefore a different project.

---

## `inputData` Format

Holds aggregated exposure and conversion counts for every metric and variant. Written by the web `/api/experiments/:id/analyze` endpoint after it queries `track-service`.

```json
{
  "metrics": {
    "cta_clicked": {
      "false": {"n": 487, "k": 41},
      "true":  {"n": 513, "k": 67}
    },
    "chat_opened": {
      "false": {"n": 487, "k": 38},
      "true":  {"n": 513, "k": 41}
    }
  }
}
```

Rules:
- Outer keys are event names — must match `primaryMetricEvent` and `guardrailEvents` in the experiment record
- Inner keys are variant values — must match `controlVariant` and `treatmentVariant` in the experiment record
- `n` = unique users exposed to that variant in the observation window
- `k` = unique users who fired the event at least once, out of those `n`
- Source: see `references/data-source-guide.md` for how events land in track-service

---

## `analysisResult` Format

Written by the web `/api/experiments/:id/analyze` endpoint (Bayesian or Bandit selected from the run's `method` field). Example output:

```json
{
  "type": "bayesian",
  "experiment": "chat-cta-v2",
  "computed_at": "2026-03-15T09:00:00Z",
  "window": { "start": "2026-03-01", "end": "2026-03-15" },
  "control": "false",
  "treatments": ["true"],
  "prior": "flat/improper (data-only)",
  "srm": {
    "chi2_p_value": 0.4821,
    "ok": true,
    "observed": { "false": 487, "true": 513 }
  },
  "primary_metric": {
    "event": "cta_clicked",
    "metric_type": "proportion",
    "rows": [
      { "variant": "false", "n": 487, "conversions": 41, "rate": 0.0842, "is_control": true },
      { "variant": "true", "n": 513, "conversions": 67, "rate": 0.1306, "rel_delta": 0.5512, "ci_lower": 0.2845, "ci_upper": 0.8179, "p_win": 0.973, "risk_ctrl": 0.0412, "risk_trt": 0.0012, "is_control": false }
    ],
    "verdict": "strong signal → adopt treatment"
  },
  "guardrails": [
    {
      "event": "chat_opened",
      "metric_type": "proportion",
      "rows": [
        { "variant": "false", "n": 487, "conversions": 38, "rate": 0.078, "is_control": true },
        { "variant": "true", "n": 513, "conversions": 41, "rate": 0.0799, "rel_delta": 0.0244, "ci_lower": -0.0981, "ci_upper": 0.1469, "p_harm": 0.459, "risk_ctrl": 0.0089, "risk_trt": 0.0084, "is_control": false }
      ],
      "verdict": "guardrail healthy"
    }
  ],
  "sample_check": {
    "minimum_per_variant": 487,
    "ok": true,
    "variants": { "false": 487, "true": 513 }
  }
}
```

Do not edit `analysisResult` by hand. Re-run the analysis script if data changes.

---

## Naming the Experiment Slug

Use `<flag-key>-<short-description>`, e.g.:
- `chat-cta-v2`
- `homepage-h1-ai-risk`
- `hero-deploy-buttons`

Kebab-case only. Matches the flag key prefix where possible.
