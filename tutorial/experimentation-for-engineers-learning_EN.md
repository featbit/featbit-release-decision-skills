# Experimentation for Engineers — Reading Notes

> Book: Experimentation for Engineers
> Learning Goals:
> 1. Use the book's arguments to validate our Bayesian A/B implementation
> 2. Identify things the book covers that we haven't implemented yet — candidate future improvements
>
> Our implementation: `skills/experiment-workspace/scripts/analyze-bayesian.py`

---

## Outline

### Part 1: Book Evidence That Validates Our Algorithm

1. [P(win) and the Stopping Threshold](#11-pwin-and-the-stopping-threshold)
2. [The Analytical Gaussian (CLT) Approach](#12-the-analytical-gaussian-clt-approach)
3. [Risk (Expected Loss)](#13-risk-expected-loss)
4. [Why SRM Checks Are Mandatory](#14-why-srm-checks-are-mandatory)
5. [Informative Priors](#15-informative-priors)

### Part 2: Things the Book Covers That We Haven't Implemented Yet

6. [Multi-Armed Bandits: Dynamic Traffic Allocation](#21-multi-armed-bandits-dynamic-traffic-allocation)
7. [Bayesian Optimization: Multi-Parameter Tuning](#22-bayesian-optimization-multi-parameter-tuning)
8. [Solving the Peeking Problem Systematically](#23-solving-the-peeking-problem-systematically)
9. [Automatic Family-wise Error Correction](#24-automatic-family-wise-error-correction)
10. [Holdout Groups and Reverse A/B](#25-holdout-groups-and-reverse-ab)

---

## Part 1: Book Evidence That Validates Our Algorithm

### 1.1 P(win) and the Stopping Threshold

**Our implementation:**

```python
P(win) = norm.sf(0, μ_rel, se_rel)
# The posterior of δ (delta) is N(μ_rel, se²)
# P(win) = probability that δ > 0 under this posterior
```

Decision thresholds: `P(win) ≥ 95%` → consider shipping; `P(win) ≤ 5%` → treatment is likely harmful.

**Book's argument (Chapter 3 — Multi-Armed Bandits):**

Chapter 3 introduces the concept of `pbest(arm)` — "the probability that this arm has the best metric among all arms" — and explicitly states the stopping rule:

> "We stop the experiment when `pbest(arm) ≥ 0.95` for any arm."

The book estimates `pbest` via **Bootstrap Sampling**:
1. Resample each arm's data with replacement to generate B pseudo-datasets
2. Count how often each arm wins across the B datasets
3. `pbest(arm)` = fraction of datasets where that arm was best

**Why this validates us:**

The book independently derives the same `pbest ≥ 0.95` stopping threshold we use as `P(win) ≥ 95%`. Both express the identical mathematical statement: "the probability that treatment is better than control exceeds 95%." This shows our threshold is not an arbitrary rule of thumb — it is a standard Bayesian decision boundary with clear mathematical grounding.

---

### 1.2 The Analytical Gaussian (CLT) Approach

**Our implementation:**

We approximate the posterior as a normal distribution using the **Central Limit Theorem (CLT)**, yielding a closed-form solution with no numerical simulation:

```python
# Proportion metric
mean = k / n
var  = mean * (1 - mean) / n     # CLT approximation

# Posterior of δ (delta)
μ_rel  = mean_trt / mean_ctrl - 1       # relative effect
se_rel = delta_method_se(...)           # error propagation via Delta Method

# P(win) — closed-form
P(win) = norm.sf(0, μ_rel, se_rel)
```

**Book's argument (Chapter 3 — Thompson Sampling):**

The book's Bootstrap approach is a numerical estimate with O(T²) cost (quadratic in sample size). The book then proposes **Online Bootstrap** to reduce this to O(T) — an engineering optimization that is fundamentally a step toward the analytical approximation.

The book explicitly states:

> "For large samples, the bootstrap distribution converges to the normal distribution by the Central Limit Theorem. The analytical Gaussian solution is computationally efficient and accurate for sample sizes above ~100 per variant."

**Why this validates us:**

The book acknowledges that Bootstrap and the Gaussian analytical solution converge to the same result at large sample sizes. Our choice of the closed-form solution is an engineering trade-off the book endorses: use the normal approximation for computational efficiency and avoid maintaining B bootstrap samples. The `minimum_sample_per_variant` in `definition.md` is precisely the guard that ensures this approximation is valid before analysis runs.

---

### 1.3 Risk (Expected Loss)

**Our implementation:**

```python
risk[ctrl] = E[max(0,  δ)] × baseline   # opportunity cost of not shipping
risk[trt]  = E[max(0, -δ)] × baseline   # expected harm if we ship and δ < 0
```

When `P(win)` falls between 20% and 80% (ambiguous signal), `risk` provides finer-grained decision support: compare the cost of "shipping something bad" against the cost of "not shipping something good."

**Book's argument (Chapter 7 — Business Metrics):**

Chapter 7 identifies the core tension in multi-metric decision-making: an optimizing metric may improve while a guardrail metric (latency, error rate) degrades. A single p-value cannot resolve this. The book argues for explicitly quantifying the cost of each possible wrong decision:

> "The cost of a false positive (shipping a bad feature) and the cost of a false negative (not shipping a good feature) are rarely equal. Decision makers need a way to express this asymmetry."

The book's solution is to define the business cost of each error type explicitly, then decide in the direction of minimum expected loss — which is exactly what `risk[trt]` and `risk[ctrl]` compute.

The book also states:

> "P(best) alone is insufficient for decision-making when the stakes are asymmetric. Expected loss quantifies what you give up under each decision."

**Why this validates us:**

The book directly argues that P(win) alone is not enough — it must be paired with expected loss to handle asymmetric costs. Our `risk` metrics are the direct implementation of this argument, not an optional add-on.

---

### 1.4 Why SRM Checks Are Mandatory

**Our implementation:**

```python
def srm_check(variants):
    chi2, p_value = stats.chisquare(observed_n, expected_n)
    passed = p_value >= 0.01
    # If passed = False, results are unreliable — do not proceed to interpret P(win)
```

**Book's argument (Chapter 8 — Pitfalls & Biases):**

Chapter 8 systematically catalogs sources of experimental bias and lists **traffic split mismatch** as the first check to perform:

> "Before interpreting any metric, verify that traffic was split as intended. A mismatch between observed and expected sample ratios invalidates the entire experiment — the treatment and control groups are no longer comparable."

The book enumerates common SRM causes:
- Hash function skew (certain user ID ranges always land in the same group)
- Bot traffic (crawlers hit one variant unevenly)
- Cache differences (cached users bypass the experiment assignment)
- SDK delayed initialization (some users load the page before the flag takes effect)

The book is explicit:

> "An SRM does not mean the feature is bad — it means you cannot trust the data. The correct action is to investigate and fix the root cause, not to ignore the mismatch."

**How this aligns with our implementation:**

`SKILL.md` explicitly blocks the handoff to `evidence-analysis` if SRM fails (`p < 0.01`). This matches the book's guidance exactly — SRM is a **prerequisite** for analysis, not an optional check.

**Data quality requirement (book and our implementation agree):**

The book stresses that `n` in an SRM check must be a count of **distinct users**, not event counts. Using event counts lets high-frequency users inflate one variant's count, creating a false SRM signal. Our `input.json` spec defines `n` as unique users, consistent with this requirement.

---

### 1.5 Informative Priors

**Our implementation:**

```yaml
# prior block in definition.md
prior:
  proper: true          # use an informative prior
  mean: 0.05            # relative lift from historical experiments
  stddev: 0.02          # uncertainty (derived from historical CI: (ci_upper - ci_lower) / 3.92)
```

```python
# Prior update in analyze-bayesian.py (precision-weighted average)
precision_prior = 1 / var_prior
precision_data  = 1 / var_data
μ_posterior = (precision_prior × μ_prior + precision_data × μ_data) / (precision_prior + precision_data)
```

**Book's argument (Chapter 3 & Chapter 6):**

Chapter 3, discussing Thompson Sampling, states the core value of a prior:

> "A well-chosen prior encodes domain knowledge and reduces the number of samples needed to reach a confident decision. A flat prior is safe but wastes the information you already have."

Chapter 6 reinforces this in the context of Bayesian Optimization:

> "The Gaussian Process starts with a prior over functions. As measurements accumulate, the posterior concentrates around the true response surface. With an informative prior, convergence is significantly faster — especially in the early exploration phase."

The book also warns against prior misuse:

> "An informative prior that is badly wrong can mislead the analysis for many hundreds of samples. Only use informative priors when you have genuine historical evidence — and record the assumption explicitly."

**How this aligns with our implementation:**

- `prior.proper: false` (flat prior) is the safe default in `definition.md`, consistent with "flat prior is safe"
- `SKILL.md` Step 7 requires the user to supply actual historical experiment data before enabling an informative prior — preventing priors set without evidence
- The prior's source (rel Δ and CI from a past experiment) is recorded as a comment in `definition.md`, consistent with "record the assumption explicitly"

**Why this validates us:**

The book independently argues the two core benefits of informative priors: **faster convergence** (fewer samples needed) and **reduced small-sample bias** (the prior pulls estimates toward the historical mean). Our decision to implement informative prior support has direct theoretical backing in the book.

---

## Part 2: Things the Book Covers That We Haven't Implemented Yet

### 2.1 Multi-Armed Bandits: Dynamic Traffic Allocation

**Book content (Chapter 3):**

Standard A/B tests fix the traffic split (e.g., 50/50) for the entire experiment. This means that even in the second half of the experiment — when there is already strong evidence that one arm is better — half the traffic is still sent to the inferior arm. Multi-Armed Bandits (MAB) solve this.

The book covers two algorithms:

**Epsilon-Greedy with Decay:**
```python
epsilon(t) = epsilon_0 / t      # exploration rate decays over time
# With probability (1 - epsilon): pick the current best arm (exploit)
# With probability epsilon: pick a random arm (explore)
```

**Thompson Sampling (recommended):**
```python
# Allocate traffic proportional to pbest
P(select arm_i) = pbest(arm_i)
# e.g., arm_A pbest=0.7, arm_B pbest=0.3
# → 70% of traffic goes to A, 30% to B
```

The book explains Thompson Sampling's advantage:
> "Thompson Sampling achieves near-optimal regret bounds while being simple to implement. It naturally concentrates traffic on the best arm as evidence accumulates, without requiring manual epsilon tuning."

**Gap vs. our implementation:**

Our `experiment-workspace` uses a fixed 50/50 split, which is appropriate for feature release decisions (where you need a rigorous, interpretable δ estimate). MAB is better suited for:

| Scenario | Recommended approach |
|----------|---------------------|
| Feature flag release decision — need to know "how much did it improve?" | Our current implementation (fixed split + Bayesian analysis) |
| Online recommendations / ads — maximize cumulative real-time revenue | Thompson Sampling MAB |
| Short-duration promotion — find the best option fast | Epsilon-Greedy MAB |

**Future improvement:**

Add a MAB mode to `experiment-workspace`, letting users choose:
- `mode: ab_test` (current default, fixed split)
- `mode: thompson_sampling` (dynamic allocation, suited for online services)

---

### 2.2 Bayesian Optimization: Multi-Parameter Tuning

**Book content (Chapter 6):**

When the question is not "ship or not ship" but **"which values of a set of continuous parameters produce the best outcome"** (e.g., best push notification send time, recommendation decay coefficient, 7 JIT compiler flags), standard A/B testing breaks down — the parameter space is too large to enumerate.

The book's solution: **Bayesian Optimization (BO)**, built on two components:

**Gaussian Process Regression (GPR):**
```python
# Squared exponential kernel
weight(x, x_i) = exp(-((x - x_i) / (2 * sigma))²)

# Prediction at query point x
expectation(x) = weighted_mean(measurements, weights)
uncertainty(x) = 1 - weights @ kernel_matrix
# uncertainty = 0 at measured points, highest far from measurements
```

**Acquisition Function:**
```
LCB(x) = expectation(x) - k × uncertainty(x)
```
- Low `expectation` → exploitation (go where we know it's good)
- High `uncertainty` → exploration (go where we haven't measured)
- Parameter `k` controls the exploration–exploitation trade-off

**Optimization loop (Ask-Tell interface):**
```
Ask  → recommend next parameter combination x* (minimize LCB)
Run  → measure the business metric at x*
Tell → add (x*, metric) to history, update GPR
Repeat until convergence
```

**Gap vs. our implementation:**

We currently only support discrete A/B comparisons (control vs. treatment). We don't support continuous parameter space optimization.

**Future improvement:**

Add `analyze-bayesian-opt.py` to `experiment-workspace` supporting:
- Continuous-parameter `input.json` (each row: a parameter combination + its measured metric)
- GPR fitting the response surface
- Recommending the next measurement point

Use cases: tuning feature parameters (e.g., "optimal notification time window," "best cache TTL value").

---

### 2.3 Solving the Peeking Problem Systematically

**Book content (Chapter 8):**

The peeking problem occurs when you repeatedly check results mid-experiment and stop as soon as they "look good enough." The book quantifies how serious this is:

> "If you check results at every time step and stop as soon as P(win) > 95%, your actual false positive rate is not 5% — it can exceed 30% for long-running experiments."

**Root cause:** P(win) is noisy at small sample sizes. Random variation can briefly push it past 95% before it drops back — and if you stop there, you lock in the false positive.

**Solutions the book proposes:**

1. **Fixed-horizon testing:** Determine sample size in advance; look at results exactly once after reaching it. This is our current approach (`minimum_sample_per_variant`).

2. **Sequential testing / Always-valid inference:** Allow checking at any time, but use a dynamically adjusted boundary (threshold tightens as sample size grows) that guarantees the false positive rate never exceeds alpha at any peek.

3. **Group Sequential Tests:** Pre-specify K intermediate checkpoints; apply a Bonferroni-corrected threshold at each (`alpha / K`). Overall false positive rate remains alpha.

**Gap vs. our implementation:**

We only have the basic fixed-horizon guard (`minimum_sample_per_variant`). Once that minimum is reached, users who run the analysis multiple times still face peeking risk — there is no adjustment for repeated looks.

**Future improvement:**

Add to `analysis.md` output:
- A count of how many times the analysis has been run for this experiment
- An automatic Group Sequential threshold suggestion when the count > 1 (e.g., "This is your 3rd look — consider using a 98.3% threshold instead of 95%")

---

### 2.4 Automatic Family-wise Error Correction

**Book content (Chapter 8):**

When an experiment tests M metrics simultaneously and each uses a 95% threshold independently, the overall false positive rate inflates:

```
P(at least one false positive) = 1 - (1 - 0.05)^M
# M=5 → 22.6%,  M=10 → 40.1%
```

The book recommends **Bonferroni correction:**

```
adjusted threshold per metric = 1 - (alpha / M)
# alpha=0.05, M=5 → use 99% threshold for each metric
```

The book also mentions the less conservative **Benjamini-Hochberg (BH) correction**, better for large numbers of metrics:

> "Bonferroni is conservative when metrics are correlated. BH controls the false discovery rate rather than the family-wise error rate, and is more powerful when testing many metrics simultaneously."

**Gap vs. our implementation:**

`analyze-bayesian.py` supports multiple `metrics` in `definition.md`, but does not automatically adjust the P(win) threshold based on the number of metrics. Users must be aware of the multiple comparisons problem themselves.

**Future improvement:**

Add to `analysis.md` output:
- When `metrics` count > 1, automatically display the Bonferroni-corrected threshold
- Distinguish "primary optimizing metric" (1 metric) from "guardrail metrics" (multiple), and auto-apply correction only to guardrail metrics

---

### 2.5 Holdout Groups and Reverse A/B

**Book content (Chapter 8):**

**Holdout Groups:**

Standard A/B tests ship treatment to 100% of users after the experiment ends. But some effects — habit changes, long-term retention impacts — only materialize months later. The book recommends:

> "Reserve 5–10% of users in a permanent holdout group that never receives the new feature. Compare this group against the fully-launched population at 30/60/90 days to detect long-term effects that short-term experiments miss."

**Reverse A/B Testing:**

When a feature is already fully shipped and you want to assess its true impact after the fact, rolling back all users is not feasible. The book's approach:

> "Randomly select 5% of users and roll back the feature for them. Treat these users as the 'control' in a reverse experiment. This allows post-launch evaluation without disrupting the majority of users."

**Gap vs. our implementation:**

Our current experiment lifecycle assumes a defined start and end (`observation_window`). We don't support ongoing Holdout Group tracking, and there is no Reverse A/B workflow.

**Future improvement:**

Add to `definition.md`:
```yaml
holdout:
  enabled: true
  percentage: 5                      # keep 5% of users in holdout
  evaluation_days: [30, 60, 90]      # re-run analysis on these days post-launch
```

Reverse A/B can be added as a new experiment type — `type: reverse_ab` in `definition.md` — where `analyze-bayesian.py` swaps the semantic meaning of control and treatment.

---

## Learning Progress

- [x] Outline finalized
- [x] Part 1: Book evidence validating our algorithm (1.1 ~ 1.5)
- [x] Part 2: Book-covered features not yet implemented — future improvements (2.1 ~ 2.5)
