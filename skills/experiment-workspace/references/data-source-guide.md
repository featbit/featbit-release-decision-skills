---
name: Data Source Guide
description: Track-service query endpoint, ExperimentQueryRequest and ExperimentQueryResponse shapes, and canonical data flow for experiment inputData.
---

# Data Source Guide

How `inputData` is produced for experiment analysis, and how to verify it.

---

## Input Contract

`inputData` is stored as a JSON string in the experiment run record:

```json
{
  "metrics": {
    "click_start_chat": {
      "false": {"n": 1234, "k": 89},
      "true":  {"n": 1198, "k": 112}
    },
    "error_rate": {
      "false": {"n": 1234, "k": 12},
      "true":  {"n": 1198, "k": 19}
    }
  }
}
```

Keys:
- Outer keys are metric event names — must match `primaryMetricEvent` and `guardrailEvents` in the experiment record
- Inner keys are variant values — must match `controlVariant` and `treatmentVariant` in the experiment record
- `n` = unique users exposed to that variant in the observation window
- `k` = unique users who fired the metric event at least once, out of those `n`

---

## Canonical Data Flow

```
Instrumentation code
  → track-service (receives flag_evaluation + metric events)
      → ClickHouse (stores raw events)
          → web app POST /api/experiments/:id/analyze
              → POST /api/query/experiment (track-service query endpoint)
                  → assembles inputData + runs analysis
                      → writes inputData + analysisResult to run record
```

Your only job is to make sure instrumentation sends events to `track-service` with the correct `envId`, `flagKey`, and event names. Once events land, the web app's `/analyze` endpoint handles the rest — no manual data assembly needed.

---

## Track-Service Query Endpoint

The web app calls track-service internally when `/analyze` runs. You do not call this endpoint directly, but understanding its shape helps debug missing data.

**Request — `POST /api/query/experiment`:**

```typescript
// ExperimentQueryRequest (from TrackPayload.cs conventions)
{
  envId:       string,   // environment ID
  flagKey:     string,   // feature flag key
  metricEvent: string,   // event name to count as conversion
  startDate:   string,   // ISO 8601 — matches run's observationStart
  endDate:     string    // ISO 8601 — matches run's observationEnd (or now if still open)
}
```

**Response — `ExperimentQueryResponse`:**

```typescript
{
  variants: Array<{
    variant:     string,   // variant value (matches controlVariant / treatmentVariant)
    users:       number,   // unique users assigned to this variant
    conversions: number,   // unique users who fired the metricEvent
    sumValue:    number,   // sum of metric values (for continuous metrics)
    sumSquares:  number    // sum of squared values (for variance calculation)
  }>
}
```

The web app maps this response into `inputData` in the canonical shape before running analysis.

---

## What `track-service` Receives from Instrumentation

Track-service receives a `TrackPayload` for each user action:

```typescript
// TrackPayload shape (from modules/track-service)
{
  user: {
    keyId: string   // the unique user identifier
  },
  variations: Array<{
    flagKey:      string,    // feature flag key
    variant:      string,    // which variant the user got
    timestamp:    string,    // ISO 8601
    experimentId: string,    // experiment record ID (for filtering)
    layerId:      string     // optional — mutual-exclusion layer
  }>,
  metrics: Array<{
    eventName:    string,    // must match primaryMetricEvent or guardrailEvents
    timestamp:    string,    // ISO 8601
    numericValue: number,    // 1 for binary events; actual value for continuous
    type:         string     // "binary" | "continuous"
  }>
}
```

Each `track()` call in the FeatBit SDK sends this payload. The SDK wires `flagKey` and `variant` automatically from the active flag evaluation — your code only needs to provide the metric event name and value.

---

## Debugging Missing Data

If `/analyze` returns `{ "status": "no_data" }`:

1. **Check flag evaluations are landing** — verify `track-service` receives `variations[]` entries with the correct `flagKey` and `envId`
2. **Check metric events are landing** — verify `metrics[]` entries arrive with the correct `eventName`
3. **Check the observation window** — `startDate` must match when the flag was enabled, not before
4. **Check `envId`** — the environment ID in track-service must match the one in the experiment record

If `/analyze` returns `{ "status": "no_data", "reason": "zero_users" }`:
- Metric events are present but no users have been assigned to variants yet
- Confirm the flag is enabled and the FeatBit SDK is calling `variation()` in the live codebase

---

## Verifying Input Data Quality

After triggering analysis, read the `inputData` written back to the run record (via `project-sync get-experiment`) and sanity-check:

- Both variant keys match `controlVariant` and `treatmentVariant` in the experiment record
- `n` values are plausible — not 0, not absurdly high
- `k` ≤ `n` for every row
- All metrics listed in `primaryMetricEvent` and `guardrailEvents` are present
- If `n` values differ significantly between variants, run the SRM check before interpreting results
