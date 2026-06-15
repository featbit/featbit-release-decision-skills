#!/usr/bin/env python3
"""
ROLE: REFERENCE ALGORITHM — pipe-only. Not called directly by the agent.

Bayesian A/B experiment analysis. Pure function of stdin → stdout:
  read a JSON payload on stdin, write the computed analysisResult JSON on
  stdout. No DB access, no HTTP calls, no file I/O.

The equivalent server-side logic lives in the web app's
`POST /api/experiments/:id/analyze` endpoint (see `src/lib/stats/analyze.ts`).
That endpoint is what the agent uses in the normal flow — this script is kept
as a readable reference of the same algorithm and is useful for offline
experimentation (e.g. feeding hand-crafted counts through `--pipe`).

Implements:
  • Analytical Gaussian Bayesian analysis (chance to win, 95% credible interval,
    risk / expected loss)
  • Sample Ratio Mismatch (SRM) check
  • Continuous metrics (mean / variance) in addition to conversion rates
  • Inverse metrics (lower is better, e.g. error_rate, latency)
  • Multiple treatment arms

Usage:
    cat input.json | python skills/experiment-workspace/scripts/analyze-bayesian.py

Requirements:
    pip install numpy scipy

──────────────────────────────────────────────────────────────────────────────
INPUT SCHEMA  (on stdin)
──────────────────────────────────────────────────────────────────────────────
{
  "slug": "...",
  "metrics": { "<event>": { "<variant>": {n, k} or {n, sum, sum_squares}, ... } },
  "control": "<variant>",
  "treatments": ["<variant>", ...],
  "observation_start": "YYYY-MM-DD",
  "observation_end": "YYYY-MM-DD",
  "prior_proper": false,
  "prior_mean": 0.0,
  "prior_stddev": 0.3,
  "minimum_sample": 0
}

OUTPUT SCHEMA  (on stdout)
──────────────────────────────────────────────────────────────────────────────
{
  "type": "bayesian",
  "experiment": "<slug>",
  "computed_at": "ISO-8601",
  "window": {"start": "...", "end": "..."},
  "control": "<variant>",
  "treatments": ["<variant>", ...],
  "prior": "<label>",
  "srm": {"chi2_p_value": 0.31, "ok": true, "observed": {"a": 612, "b": 588}},
  "primary_metric": { ... metric section ... },
  "sample_check": {"minimum_per_variant": 400, "ok": true, "variants": {...}}
}
──────────────────────────────────────────────────────────────────────────────
"""

import json
import sys
from datetime import datetime, timezone

from stats_utils import (
    ALPHA,
    GaussianPrior,
    bayesian_result,
    extract_guardrails,
    extract_prior,
    extract_variants,
    metric_moments,
    srm_check,
)


# ══════════════════════════════════════════════════════════════════════════════
# METRIC RESULT (returns structured dict)
# ══════════════════════════════════════════════════════════════════════════════

def compute_metric_section(
    label: str,
    mdata: dict,
    control: str,
    treatments: list[str],
    is_guardrail: bool = False,
    prior: GaussianPrior | None = None,
) -> dict | None:
    """
    Compute one metric block as a structured dict.

    Returns a dict with:
      event, metric_type, inverse, rows[], verdict
    """
    inverse  = bool(mdata.get("inverse", False))
    ctrl_raw = mdata.get(control, {})
    if not ctrl_raw or not isinstance(ctrl_raw, dict):
        return None

    mean_a, var_a, n_a = metric_moments(ctrl_raw)
    is_prop = "k" in ctrl_raw
    kind    = "proportion" if is_prop else "continuous"

    rows = []
    # Control row
    ctrl_row: dict = {"variant": control, "n": n_a, "is_control": True}
    if is_prop:
        ctrl_row["conversions"] = int(ctrl_raw.get("k", 0))
        ctrl_row["rate"] = round(mean_a, 6)
    else:
        ctrl_row["mean"] = round(mean_a, 4)
    rows.append(ctrl_row)

    verdicts = []

    for trt in treatments:
        trt_raw = mdata.get(trt, {})
        if not trt_raw or not isinstance(trt_raw, dict):
            continue

        mean_b, var_b, n_b = metric_moments(trt_raw)
        bay = bayesian_result(mean_a, var_a, n_a, mean_b, var_b, n_b, inverse, prior)

        trt_row: dict = {"variant": trt, "n": n_b, "is_control": False}

        if is_prop:
            trt_row["conversions"] = int(trt_raw.get("k", 0))
            trt_row["rate"] = round(mean_b, 6)
        else:
            trt_row["mean"] = round(mean_b, 4)

        if bay.get("error"):
            rows.append(trt_row)
            continue

        trt_row["rel_delta"]  = round(bay["relative_change"], 6)
        trt_row["ci_lower"]   = round(bay["ci_rel_lower"], 6)
        trt_row["ci_upper"]   = round(bay["ci_rel_upper"], 6)

        if is_guardrail:
            trt_row["p_harm"]     = round(1.0 - bay["chance_to_win"], 4)
            trt_row["risk_ctrl"]  = round(bay["risk_ctrl"], 6)
            trt_row["risk_trt"]   = round(bay["risk_trt"], 6)
        else:
            trt_row["p_win"]      = round(bay["chance_to_win"], 4)
            trt_row["risk_ctrl"]  = round(bay["risk_ctrl"], 6)
            trt_row["risk_trt"]   = round(bay["risk_trt"], 6)

        rows.append(trt_row)

        # Generate verdict
        ctw = bay["chance_to_win"]
        prefix = f"{trt}: " if len(treatments) > 1 else ""
        if is_guardrail:
            p_harm = 1.0 - ctw
            if p_harm < 0.1:
                verdicts.append(f"{prefix}guardrail healthy")
            elif p_harm < 0.3:
                verdicts.append(f"{prefix}guardrail borderline — monitor")
            else:
                verdicts.append(f"{prefix}guardrail ALARM — possible regression")
        else:
            if ctw >= 0.95:
                verdicts.append(f"{prefix}strong signal → adopt treatment")
            elif ctw >= 0.80:
                verdicts.append(f"{prefix}leaning treatment")
            elif ctw <= 0.05:
                verdicts.append(f"{prefix}treatment appears harmful")
            elif ctw <= 0.20:
                verdicts.append(f"{prefix}leaning control")
            else:
                verdicts.append(f"{prefix}inconclusive")

    section: dict = {
        "event": label,
        "metric_type": kind,
        "rows": rows,
        "verdict": "; ".join(verdicts) if verdicts else "no data",
    }
    if inverse:
        section["inverse"] = True

    return section


# ══════════════════════════════════════════════════════════════════════════════
# MAIN  (stdin JSON → compute → stdout JSON)
# ══════════════════════════════════════════════════════════════════════════════

def main() -> None:
    raw = json.loads(sys.stdin.read())

    slug         = raw.get("slug", "unknown")
    metrics_data = raw.get("metrics", {})
    control      = raw.get("control", "")
    treatments   = raw.get("treatments", [])
    min_sample   = int(raw.get("minimum_sample", 0))

    prior_proper = bool(raw.get("prior_proper", False))
    prior_mean   = float(raw.get("prior_mean", 0.0))
    prior_stddev = float(raw.get("prior_stddev", 0.3))
    prior = GaussianPrior(
        mean=prior_mean,
        variance=prior_stddev ** 2,
        proper=prior_proper,
    )

    now       = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    start_lbl = raw.get("observation_start", "?")
    end_lbl   = raw.get("observation_end", "open")

    all_variants = [control] + treatments

    prior_label = (
        f"proper (mean={prior.mean}, stddev={prior.variance ** 0.5:.3g})"
        if prior.proper else "flat/improper (data-only)"
    )

    # ── SRM check ──
    srm_result = {"chi2_p_value": 0.0, "ok": True, "observed": {}}
    first_event = next(iter(metrics_data), None)
    if first_event and first_event in metrics_data:
        pm = metrics_data[first_event]
        ns = [
            pm.get(v, {}).get("n", 0)
            for v in all_variants
            if isinstance(pm.get(v), dict)
        ]
        if len(ns) >= 2 and sum(ns) > 0:
            srm_p = srm_check(ns)
            srm_result = {
                "chi2_p_value": round(srm_p, 4),
                "ok": srm_p >= 0.01,
                "observed": {v: n for v, n in zip(all_variants, ns)},
            }

    # ── Primary metric (first metric in dict) ──
    primary_section = None
    if first_event:
        primary_section = compute_metric_section(
            first_event, metrics_data[first_event],
            control, treatments, is_guardrail=False, prior=prior,
        )

    # ── Sample size check ──
    primary_md = metrics_data.get(first_event, {}) if first_event else {}
    variant_ns = {}
    for v in all_variants:
        variant_ns[v] = primary_md.get(v, {}).get("n", 0) if primary_md else 0
    min_observed = min(variant_ns.values()) if variant_ns else 0
    sample_ok    = (min_observed >= min_sample) if min_sample > 0 else True

    # ── Assemble output ──
    output: dict = {
        "type": "bayesian",
        "experiment": slug,
        "computed_at": now,
        "window": {"start": start_lbl, "end": end_lbl},
        "control": control,
        "treatments": treatments,
        "prior": prior_label,
        "srm": srm_result,
    }
    if primary_section:
        output["primary_metric"] = primary_section
    output["sample_check"] = {
        "minimum_per_variant": min_sample,
        "ok": sample_ok,
        "variants": variant_ns,
    }

    # Write JSON to stdout
    json.dump(output, sys.stdout, indent=2)


if __name__ == "__main__":
    main()
