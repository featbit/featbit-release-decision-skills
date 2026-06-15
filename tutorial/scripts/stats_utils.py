"""
Shared statistical utilities for experiment analysis scripts.

Used by:
    analyze-bayesian.py  — Bayesian A/B analysis
    analyze-bandit.py    — Thompson Sampling MAB weight computation
"""

import json
from dataclasses import dataclass

import numpy as np
from scipy.stats import chi2 as chi2_dist
from scipy.stats import norm
from scipy.stats import truncnorm

ALPHA = 0.05  # credible interval = 1 − ALPHA


# ══════════════════════════════════════════════════════════════════════════════
# PRIOR
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class GaussianPrior:
    """
    Gaussian prior on the relative effect δ = (mean_b − mean_a) / mean_a.

    proper=False  → flat/improper prior (default); posterior = data likelihood only.
    proper=True   → informative prior; posterior is the precision-weighted average
                    of the prior and the data estimate (conjugate Gaussian update).

    Recommended defaults when enabling a proper prior:
        mean   = 0.0   (no expected direction)
        stddev = 0.3   (±30% relative lift is the plausible range)
    """
    mean: float = 0.0
    variance: float = 1e10   # effectively flat when proper=False
    proper: bool = False


# ══════════════════════════════════════════════════════════════════════════════
# METRIC MOMENTS
# ══════════════════════════════════════════════════════════════════════════════

def metric_moments(vdata: dict) -> tuple[float, float, int]:
    """
    Return (per-unit mean, per-unit variance, n) from a variant data dict.

    Proportion  {"n": N, "k": K}                      → Bernoulli variance p(1−p)
    Continuous  {"n": N, "sum": S, "sum_squares": SS}  → sample variance
    """
    n = int(vdata.get("n", 0))
    if n == 0:
        return 0.0, 0.0, 0
    if "k" in vdata:
        mean = float(vdata["k"]) / n
        var  = mean * (1.0 - mean)
    else:
        s    = float(vdata.get("sum", 0.0))
        ss   = float(vdata.get("sum_squares", 0.0))
        mean = s / n
        var  = (ss - s * s / n) / (n - 1) if n > 1 else 0.0
    return mean, var, n


# ══════════════════════════════════════════════════════════════════════════════
# BAYESIAN ANALYSIS
# ══════════════════════════════════════════════════════════════════════════════

def _delta_method_se(
    mean_a: float, var_a: float, n_a: int,
    mean_b: float, var_b: float, n_b: int,
    relative: bool,
) -> float:
    """
    Standard error for (mean_b − mean_a) [absolute] or
    (mean_b − mean_a) / mean_a [relative] via the delta method.
    """
    if relative:
        if mean_a == 0:
            return 0.0
        return float(np.sqrt(
            var_b / (n_b * mean_a ** 2)
            + var_a * mean_b ** 2 / (n_a * mean_a ** 4)
        ))
    return float(np.sqrt(var_b / n_b + var_a / n_a))


def _truncated_normal_mean(mu: float, sigma: float, a: float, b: float) -> float:
    """E[X | a < X ≤ b] for X ~ N(mu, sigma²)."""
    alpha_tn = (a - mu) / sigma
    beta_tn  = (b - mu) / sigma
    return float(truncnorm.stats(alpha_tn, beta_tn, loc=mu, scale=sigma, moments="m"))


def _risk(mu: float, sigma: float) -> tuple[float, float]:
    """
    (risk_ctrl, risk_trt) where δ ~ N(mu, sigma²) is the relative treatment effect.

    risk_ctrl = E[max(0, δ)]  — expected opportunity cost of keeping control
    risk_trt  = E[max(0,−δ)] — expected loss from adopting treatment
    """
    p_ctrl_better = float(norm.cdf(0.0, loc=mu, scale=sigma))
    mn_neg = _truncated_normal_mean(mu, sigma, -np.inf, 0.0)
    mn_pos = _truncated_normal_mean(mu, sigma,  0.0, np.inf)
    return float((1.0 - p_ctrl_better) * mn_pos), float(-p_ctrl_better * mn_neg)


def bayesian_result(
    mean_a: float, var_a: float, n_a: int,
    mean_b: float, var_b: float, n_b: int,
    inverse: bool = False,
    prior: GaussianPrior | None = None,
) -> dict:
    """
    Analytical Gaussian-posterior Bayesian A/B test.

    Returns a dict with:
      chance_to_win    P(treatment is better)
      relative_change  posterior mean of (mean_b − mean_a) / mean_a
      absolute_change  mean_b − mean_a  (observed)
      ci_rel_lower     lower bound of 95% credible interval (relative)
      ci_rel_upper     upper bound of 95% credible interval (relative)
      risk_ctrl        opportunity cost of keeping control
      risk_trt         downside risk of adopting treatment
      prior_applied    True if a proper prior was used
      error            None or an error string
    """
    if n_a == 0 or n_b == 0:
        return {"error": "zero sample size"}
    if mean_a == 0:
        return {"error": "control mean is zero — cannot compute relative effect"}

    se_rel = _delta_method_se(mean_a, var_a, n_a, mean_b, var_b, n_b, relative=True)
    if se_rel == 0:
        return {"error": "zero standard error (no variance in data)"}

    mu_rel = (mean_b - mean_a) / mean_a
    mu_abs = mean_b - mean_a

    prior_applied = False
    if prior is not None and prior.proper:
        data_prec  = 1.0 / (se_rel ** 2)
        prior_prec = 1.0 / prior.variance
        post_prec  = data_prec + prior_prec
        mu_rel     = (mu_rel * data_prec + prior.mean * prior_prec) / post_prec
        se_rel     = float(np.sqrt(1.0 / post_prec))
        prior_applied = True

    z_half = float(norm.ppf(1.0 - ALPHA / 2))

    ctw = float(norm.sf(0.0, loc=mu_rel, scale=se_rel))
    if inverse:
        ctw = 1.0 - ctw

    risk_c, risk_t = _risk(mu_rel, se_rel)
    if inverse:
        risk_c, risk_t = risk_t, risk_c

    return {
        "error":           None,
        "chance_to_win":   ctw,
        "relative_change": mu_rel,
        "absolute_change": mu_abs,
        "ci_rel_lower":    mu_rel - z_half * se_rel,
        "ci_rel_upper":    mu_rel + z_half * se_rel,
        "risk_ctrl":       risk_c,
        "risk_trt":        risk_t,
        "prior_applied":   prior_applied,
    }


# ══════════════════════════════════════════════════════════════════════════════
# SRM CHECK
# ══════════════════════════════════════════════════════════════════════════════

def srm_check(observed: list[int], expected_weights: list[float] | None = None) -> float:
    """
    Chi-squared SRM test. Returns p-value; p < 0.01 is the common alarm threshold.
    expected_weights defaults to equal allocation across all variants.
    """
    total = sum(observed)
    if total == 0:
        return 1.0
    k = len(observed)
    if expected_weights is None:
        expected_weights = [1.0 / k] * k
    total_w = sum(expected_weights)
    chi_sq  = sum(
        (o - w / total_w * total) ** 2 / (w / total_w * total)
        for o, w in zip(observed, expected_weights)
        if w > 0
    )
    return float(chi2_dist.sf(chi_sq, k - 1))


# ══════════════════════════════════════════════════════════════════════════════
# EXPERIMENT RECORD HELPERS  (extract structured fields from DB experiment dict)
# ══════════════════════════════════════════════════════════════════════════════

def extract_variants(experiment: dict) -> tuple[str, list[str]]:
    """
    Return (control, [treatments]) from a DB experiment record.

    `treatmentVariant` may be a single value or comma-separated for multi-arm.
    """
    control = experiment.get("controlVariant") or "control"
    treatment_raw = experiment.get("treatmentVariant") or "treatment"
    treatments = [t.strip() for t in treatment_raw.split(",") if t.strip()]
    return control, treatments


def extract_prior(experiment: dict) -> GaussianPrior:
    """Build a GaussianPrior from DB experiment fields."""
    proper = bool(experiment.get("priorProper", False))
    mean = float(experiment.get("priorMean") or 0.0)
    stddev = float(experiment.get("priorStddev") or 0.3)
    return GaussianPrior(mean=mean, variance=stddev ** 2, proper=proper)


def extract_guardrails(experiment: dict) -> list[str]:
    """Parse guardrail event names from the DB experiment record."""
    raw = experiment.get("guardrailEvents")
    if not raw:
        return []
    if isinstance(raw, list):
        return list(raw)
    if isinstance(raw, str):
        stripped = raw.strip()
        if stripped.startswith("["):
            return json.loads(stripped)
        # Plain string (single event or comma-separated)
        return [s.strip() for s in stripped.split(",") if s.strip()]
    return []


# ══════════════════════════════════════════════════════════════════════════════
# FORMATTING
# ══════════════════════════════════════════════════════════════════════════════

def _pct(x: float) -> str:
    return f"{x * 100:+.2f}%"
