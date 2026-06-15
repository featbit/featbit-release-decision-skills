# Bayesian A/B Analysis — Learning Tutorial

> This tutorial walks through the Bayesian A/B testing logic implemented in `analyze-bayesian.py` and documented in `references/analysis-bayesian.md` inside `experiment-workspace`.
> It records real questions and answers from the learning session, serving as ongoing context for continued study.

---

## Chapter 1: Why Bayesian?

Traditional A/B testing (frequentist) asks a counterfactual question:

> "Assuming treatment has **no effect**, how probable is it that I would observe this data?"

That is the p-value. It answers an indirect question and is not intuitive to act on.

Bayesian directly answers:

> "Given the data I collected, how probable is it that treatment is **truly better**?"

The output is `P(win) = 94%`, meaning: based on the current data, there is a 94% probability that treatment is genuinely better. This can be acted on directly.

---

## Chapter 2: Two Metric Types

### How to decide

Look at the shape of your raw data:

| Question | Metric type | Examples |
|----------|-------------|---------|
| Each user either did it or didn't | Proportion metric | Clicked or not, signed up or not, purchased or not |
| Each user has a concrete numeric value | Continuous metric | Revenue spent, session duration, articles read |

### Input data format

```json
// Proportion metric: only n and k
"cta_clicked": {
  "control":   {"n": 5000, "k": 300},
  "treatment": {"n": 5050, "k": 350}
}

// Continuous metric: n, sum, and sum_squares
"revenue_per_user": {
  "control":   {"n": 5000, "sum": 45000.0,  "sum_squares": 820000.0},
  "treatment": {"n": 5050, "sum": 48020.0,  "sum_squares": 901000.0}
}
```

### What is sum_squares?

`sum_squares` is the sum of each user's value **squared individually, then added together**:

```
sum_squares = x₁² + x₂² + x₃² + ... + xₙ²
```

This is **not** `(x₁ + x₂ + ... + xₙ)²` — it is not the square of the sum.

**Why is it needed?** Because the variance formula is:

```
var = (sum_squares - sum²/n) / (n - 1)
```

You cannot derive variance from `sum` alone — `sum_squares` is required. In practice, data lives in a database and you aggregate it with a single query:

```sql
SELECT
  COUNT(*)            AS n,
  SUM(value)          AS sum,
  SUM(value * value)  AS sum_squares
FROM events
WHERE variant = 'control'
```

Three numbers from one SQL query. The script derives both mean and variance from these.

### Edge case: inverse metrics

For metrics where lower is better (error rate, latency), add `"inverse": true`. P(win) then means "probability that treatment has a lower value."

---

## Chapter 3: Every Variable — Definition and Calculation

### 3.1 Proportion metric example

**Scenario:** Testing whether a new CTA button improves click-through rate.

**Raw data:**

| Variant | Exposed (n) | Converted (k) |
|---------|-------------|---------------|
| control | 5000 | 300 |
| treatment | 5050 | 350 |

**mean = conversion rate:**

```
mean_a = 300 / 5000 = 0.06     (6.00%)
mean_b = 350 / 5050 = 0.06931  (6.93%)
```

**var = dispersion of individual user behaviour:**

For proportion metrics each user is 0 or 1, so variance is determined by the mean itself:

```
var_a = 0.06 × (1 - 0.06)      = 0.0564
var_b = 0.06931 × (1 - 0.06931) = 0.06450
```

The closer the mean is to 0.5, the larger the variance (maximum uncertainty). The closer to 0 or 1, the smaller the variance.

**μ_rel = observed relative effect (point estimate):**

```
μ_rel = (mean_b - mean_a) / mean_a
      = (0.06931 - 0.06) / 0.06
      = +15.52%
```

> Naming note: the same value appears under three different names — **μ_rel** in this tutorial, **δ (delta)** as a mathematical symbol, and **`rel Δ`** (short for "relative delta") as the column name in the `analysis.md` output table. All three refer to the same number.

**se = how uncertain we are about μ_rel:**

Computed via the Delta Method:

```
se = sqrt(
    var_b / (n_b × mean_a²)
  + var_a × mean_b² / (n_a × mean_a⁴)
)
≈ 8.79%
```

Larger se = smaller sample or higher variance = less reliable estimate.
The denominator contains `mean_a²`, so the lower the baseline conversion rate, the larger the se — low-conversion experiments are inherently more uncertain.

---

### 3.2 Continuous metric example

**Scenario:** Testing whether a new checkout flow increases revenue per user.

**Raw data:**

| Variant | n | sum | sum_squares |
|---------|---|-----|-------------|
| control | 5000 | 45000.0 | 820000.0 |
| treatment | 5050 | 48020.0 | 901000.0 |

**Calculation:**

```
# control
mean_a = 45000 / 5000 = 9.0 ($/user)
var_a  = (820000 - 45000²/5000) / (5000-1)
       = (820000 - 810000) / 4999
       ≈ 2.0004

# treatment
mean_b = 48020 / 5050 ≈ 9.509 ($/user)
var_b  = (901000 - 48020²/5050) / (5050-1)
       ≈ 88.01
```

Note: continuous metric variance tends to be much larger than proportion metric variance (users vary widely in revenue). However, with a large enough n, se can still be small.

```
μ_rel = (9.509 - 9.0) / 9.0 = +5.65%
se    ≈ 1.64%

P(win) = norm.sf(0, 0.0565, 0.01637) ≈ 99.97%
```

---

## Chapter 4: The Posterior Distribution N(μ_rel, se²)

### What is N?

`N` is the **Normal distribution (Gaussian distribution)**. The notation `N(μ, σ²)` means:

- `μ` = mean (the most likely value)
- `σ²` = variance; `σ = se` = standard deviation (the degree of uncertainty)

Note: the second parameter of `N(μ, σ²)` is the variance (σ²), not the standard deviation (σ). The code works with `se` (i.e. σ) because standard deviation shares the same unit as the data and is more intuitive to reason about.

### Why a distribution, not a single number?

Because you **do not know the true value of δ** — you can only say it is probably somewhere in a range.

Analogy: a friend says "I'll arrive around 3pm, give or take half an hour." They are not giving you a precise time — they are giving you an estimate with uncertainty attached. A normal distribution is the mathematical expression of exactly that:

```
μ = most likely value (3pm)
σ = degree of uncertainty (half an hour)
```

In A/B testing, the observed δ = +15.52% is just one sample. If you ran the experiment again, the data would differ slightly and δ would be slightly different. The normal distribution describes: **how probable is it that the true δ falls at each possible value?**

### Why can we use the normal distribution as an approximation?

This comes from the **Central Limit Theorem (CLT)**:

> When the sample size is large enough, the distribution of the sample mean approaches a normal distribution — regardless of the shape of the original data.

This is why the script requires at least **30 conversions per variant** — below that, the CLT has not yet kicked in, the normal approximation is unreliable, and P(win) and risk values may be misleading.

---

## Chapter 5: How P(win) Is Computed

### Intuition

`P(win) = probability that δ > 0 = area under the posterior curve to the right of 0`

```
         ▲
         │         ┌───┐
         │       ┌─┘███└─┐
         │      ─┘███████└─
         │   ───████████████───
         └─────┬───────────────▶ δ (relative lift)
               0   +μ_rel
         ←────→←──────────────→
        P(ctrl wins)  P(win)
```

Because the mean +15.52% sits well to the right of 0, the area to the right (P(win)) is large.

### Code

```python
ctw = norm.sf(0.0, loc=μ_rel, scale=se)
```

`sf` = survival function = `1 - CDF`, i.e. **the probability of being greater than a given value**:

```
norm.sf(0, loc=0.1552, scale=0.0879)
= P(δ > 0) where δ ~ N(0.1552, 0.0879²)
= P(treatment's true lift > 0)
= P(win)
≈ 96.1%
```

The mean is about 1.76 standard deviations above 0 (0.1552 / 0.0879), which is why the probability is high.

---

## Chapter 6: How This Relates to Bayes

A common source of confusion: the calculations above all look like frequentist tools (mean, variance, standard error). Where does Bayes come in?

**Bayes' theorem:**

```
posterior ∝ prior × likelihood
```

**Default mode (flat prior, `proper: false`):**

The prior is "flat" — it treats all possible values of δ equally with no preference. Therefore:

```
posterior ∝ 1 × likelihood = likelihood
```

The posterior equals the data likelihood. `N(μ_rel, se²)` is a Gaussian approximation of that likelihood — when the sample is large enough (CLT), the likelihood surface is approximately normal.

The full computation pipeline is:

```
Observed data
  → compute point estimate μ_rel and uncertainty se    (frequentist tools)
  → approximate posterior as N(μ_rel, se²)             (Bayesian framework)
  → derive P(win), CI, risk from the posterior          (Bayesian outputs)
```

**The value of Bayes is the framing, not the computation method.** It allows you to say "P(win) = 96%" — a direct probability statement. In frequentist testing you cannot say "there is a 96% probability treatment is better"; you can only say "p < 0.05, reject the null hypothesis."

**When you enable `proper: true`, Bayes genuinely enters the computation:**

```
post_mean = (data_mean/data_var + prior_mean/prior_var)
          / (1/data_var + 1/prior_var)
post_std  = sqrt(1 / (1/data_var + 1/prior_var))
```

The prior pulls the posterior mean toward historical knowledge. With small samples the prior dominates; with large samples the data overwhelms the prior — something a purely frequentist approach cannot do.

---

## Chapter 7: 95% Credible Interval

### Frequentist Confidence Interval vs Bayesian Credible Interval

The strict meaning of a **frequentist confidence interval** is counterintuitive:

> "If I repeated this experiment 100 times, 95 of the resulting intervals would contain the true value."

It describes the long-run performance of the interval-construction method — not that "the true value has a 95% probability of being inside this interval."

A **Bayesian credible interval** says directly:

> "The true δ (delta) has a 95% probability of falling within this interval."

This is what most people assume a confidence interval means. Bayesian makes that statement mathematically valid.

---

### Why can Bayesian make this claim?

The key is: **Bayesian treats δ itself as a random variable. Frequentist does not.**

**Frequentist worldview:**
> The true δ is a fixed number — you just don't know what it is. A fixed number has no probability — it either falls in the interval or it doesn't. So frequentists can only say: "my interval-construction method has a 95% hit rate in the long run."

**Bayesian worldview:**
> I have uncertainty about the true δ, and that uncertainty can be expressed as probability. δ is random to me — not because it truly varies, but because **I don't know its true value**. So I can say: "given the data I observed, there is a 95% probability that δ falls in this interval."

**Everyday analogy:**

You can't find your keys:
- Frequentist: the keys are in a fixed location. I can't say "there's a 70% chance they're in the kitchen." I can only say "my search strategy has a 95% success rate in the long run."
- Bayesian: I don't know where the keys are — based on my memory, 70% chance they're in the kitchen, 20% in the bedroom, 10% somewhere else.

Bayesian allows you to express **subjective uncertainty** as probability.

---

### How the script computes it

The posterior is `N(μ_rel, se²)`. The 95% credible interval is the **middle 95% of that normal curve**:

```
ci_lower = μ_rel - 1.96 × se
ci_upper = μ_rel + 1.96 × se
```

Why 1.96? A property of the normal distribution: ±1.96 standard deviations from the mean covers exactly 95% of the area.

```python
z_half   = norm.ppf(1.0 - 0.05 / 2)   # = 1.96
ci_lower = μ_rel - z_half × se
ci_upper = μ_rel + z_half × se
```

Using the CTA click-rate example:

```
μ_rel = +15.52%,  se = 8.79%

ci_lower = 15.52% - 1.96 × 8.79% = +0.29%
ci_upper = 15.52% + 1.96 × 8.79% = +30.75%

95% credible interval: [+0.29%, +30.75%]
```

Meaning: **after seeing this data, the true lift has a 95% probability of being between +0.29% and +30.75%.**

The wide interval reflects se = 8.79% — the sample is not yet large enough. As sample size grows, se shrinks and the interval narrows.

---

### What is the credible interval useful for?

**1. Judging whether the result has practical significance**

P(win) only tells you the direction. CI tells you the magnitude:

```
Case A: P(win) = 96%, CI = [+0.1%, +1.2%]  → lift may be tiny — worth shipping?
Case B: P(win) = 96%, CI = [+8%,  +25%]   → even the conservative estimate is +8%
```

**P(win) tells you direction. CI tells you magnitude.**

**2. Judging whether to keep running**

```
Early   (small n): CI = [-5%, +35%]   → very wide, still uncertain — keep running
Middle  (more n):  CI = [+3%, +28%]   → narrowing, but still a wide range
Late    (large n): CI = [+10%, +21%]  → stable and narrow — ready to decide
```

**3. Comparing against your MDE**

MDE (Minimum Detectable Effect) = the smallest lift that is worth acting on.

Example with MDE = +5%:

```
CI = [+0.1%, +12%]  → lower bound below MDE — keep running
CI = [+6%,  +18%]   → entire interval above MDE — ready to decide
CI = [+0.5%, +3%]   → entire interval below MDE — not worth shipping even if treatment wins
```

---

## Chapter 8: Risk (Expected Loss)

### Intuition

Risk answers two symmetric questions:

| Question | Corresponding risk |
|----------|--------------------|
| If I **don't ship** treatment, but treatment is actually better — how much opportunity did I lose? | `risk[ctrl]` |
| If I **ship** treatment, but control is actually better — how much did I lose? | `risk[trt]` |

Both values are "expected loss" — not the worst case, but the **probability-weighted average loss**.

---

### Formula

```
risk[ctrl] = E[max(0,  δ)] = ∫₀^∞  δ · p(δ) dδ
risk[trt]  = E[max(0, -δ)] = ∫₋∞^0 |δ| · p(δ) dδ
```

In plain language:

- `risk[ctrl]`: take the **δ > 0 portion** of the posterior curve, weighted by probability — if you stay on control while treatment is actually better, how much relative lift do you lose on average?
- `risk[trt]`: take the **δ < 0 portion** of the posterior curve, weighted by probability — if you ship treatment while control is actually better, how much do you lose on average?

---

### Example 1: Proportion metric (CTA click-through rate)

Posterior: `δ ~ N(+15.52%, 8.79%²)`, P(win) = 96.1%

Because the posterior mean sits far to the right of 0:
- Only 3.9% of the curve is in δ < 0 territory → `risk[trt]` is very small
- 96.1% of the curve is in δ > 0 territory → `risk[ctrl]` is large

Actual output:
```
risk[ctrl] = 0.1498   (not shipping costs ~15% of the control mean in expected opportunity)
risk[trt]  = 0.0026   (shipping and being wrong costs ~0.26% of the control mean)
```

**Conclusion: the cost of shipping is negligible (0.26%), the cost of not shipping is high (15%). Ship it.**

To interpret 0.26%: control click rate is 6%, so `risk[trt] = 0.0026` means an average loss of 0.0026 × 6% ≈ 0.016% in click rate — essentially negligible.

---

### Example 2: Continuous metric (revenue per user)

Posterior: `δ ~ N(+5.65%, 1.64%²)`, P(win) = 99.97%

The posterior mean is even further from 0 (~3.4 standard deviations), so results are highly certain:

```
risk[ctrl] = 0.0565   (not shipping costs ~5.65% of the control mean)
risk[trt]  = 0.0000   (shipping and being wrong costs almost nothing)
```

**Conclusion: P(win) is extremely high, risk[trt] is near zero. Ship it.**

To interpret: control mean is $9.0/user, so `risk[trt] ≈ 0` means the downside of being wrong is negligible.

---

### How this relates to "shipping cost"

Before shipping treatment, you need to ask: **if I'm wrong, is the expected loss smaller than the cost of shipping itself?**

`risk[trt]` is the precise quantification of that question:

| risk[trt] | Interpretation |
|-----------|----------------|
| < 0.001 | Loss < 0.1% — safe to ship |
| 0.001 – 0.01 | Loss 0.1%–1% — acceptable for most product decisions |
| > 0.01 | Loss > 1% — weigh against business context before deciding |

---

### Example 3: What does "weigh against business context" mean?

**Scenario:** Testing a new checkout flow:

```
P(win)          = 87%
risk[trt]       = 0.018   (~1.8% of control mean)
control mean    = $50/user revenue
```

`risk[trt] = 0.018` means: if you ship and you're wrong, average loss = 0.018 × $50 = **$0.90/user**.

**Same numbers, two different business contexts, two different conclusions:**

**Context A: E-commerce platform with 1M daily active users**
```
Daily loss = $0.90 × 1,000,000 = $900,000/day
```
P(win) is only 87% and the downside is large. → **Keep running. Wait until risk[trt] drops below 0.005.**

**Context B: Early-stage product with 1,000 daily active users**
```
Daily loss = $0.90 × 1,000 = $900/day
```
The engineering change takes half a day, and validating this direction is urgent. → **Acceptable. Ship and monitor.**

**Key takeaway:** `risk[trt]` gives you a **relative proportion**, not an absolute dollar amount. You need to convert it into business units yourself, then weigh it against shipping cost and business urgency. This judgment step belongs to `evidence-analysis` — the script does not make this call for you.

---

## Chapter 9: SRM Check (Sample Ratio Mismatch)

### What is SRM?

You configured a 50/50 split, but the actual data shows control=5000, treatment=4750 — is this normal random variation, or is something wrong?

The SRM check uses a **χ² (chi-squared) test** to answer this: is the difference between the observed traffic split and the expected split beyond what random variation can explain?

```python
srm_p = srm_check([n_control, n_treatment])
# p < 0.01 → red flag, traffic allocation is off
```

When p-value < 0.01, the output is:
```
⚠ POSSIBLE IMBALANCE — investigate before interpreting results
```

---

### Why does Bayesian analysis need an SRM check?

The fundamental assumption of Bayesian analysis is that control and treatment have **comparable user populations**.

If traffic allocation went wrong — say treatment accidentally attracted more high-value users — then the observed δ is not because treatment is better, but because **the two groups were different to begin with**. In that case, P(win) = 96% is meaningless — garbage in, garbage out.

**Analogy:** You want to compare the food quality of two restaurants, but one is full of food critics and the other is full of people grabbing a quick lunch. Different ratings don't mean different food quality — the samples themselves are incomparable.

The correct flow is:

```
Receive data
  → Run SRM check first
  → SRM passes → run Bayesian analysis → read P(win) / risk / CI
  → SRM fails  → stop and investigate, do not read Bayesian results
```

In the script, `srm_block` always appears at the top of `analysis.md` — the order is fixed.

---

### Why does SRM use p-value instead of Bayesian?

SRM and Bayesian analysis are two independent problems that use different tools:

| Question | Tool | Why |
|----------|------|-----|
| Is treatment better? | Bayesian posterior | Needs a direct probability statement for decision-making |
| Is traffic allocation normal? | Frequentist χ² test | Only needs a yes/no alarm — p-value is sufficient |

SRM only needs to answer a binary question: "is this deviation random noise or a systematic problem?" For anomaly detection, p-value is exactly the right tool.

> Bayesian is for **quantifying effects**. Frequentist is for **detecting anomalies**. Both coexist in the same script without conflict.

---

### Why feature flag setups are especially prone to SRM

**1. SDK initialisation timing**
A user enters the page before the flag evaluation completes, and an event fires before the exposure is recorded. Some users get assigned a variant but are not counted as exposed.

**2. Cache or persistence inconsistency**
A user is assigned to treatment on their first visit, then clears cookies or switches devices and gets assigned to control — the same user ends up counted in both buckets.

**3. Staged rollout**
You didn't open to 50/50 all at once — you went 10%, then 30%, then 50%. The experiment window start time doesn't match when the split was truly 50/50, polluting early data.

**4. Bot traffic**
Crawlers get assigned to a variant but behave very differently from real users, and tend to cluster in one bucket.

---

### SRM check input: n must be unique user count

The SRM check needs only one input: **the number of exposed users `n` per variant**.

The script reads it directly from the primary metric in `input.json`:

```python
ns = [pm.get(v, {}).get("n", 0) for v in all_variants]
srm_p = srm_check(ns)
```

**Critical: `n` must be unique user exposure count (DISTINCT users), not event count.**

| Data source | Meaning | Valid for SRM? |
|-------------|---------|----------------|
| Flag evaluation count | Same user may be evaluated multiple times | ❌ Wrong |
| Unique user exposure count | Each user counted once | ✅ Correct |

Correct query:

```sql
SELECT variant, COUNT(DISTINCT user_key) AS n
FROM exposures
WHERE experiment_slug = '<slug>'
  AND timestamp BETWEEN start AND end
GROUP BY variant
```

---

### The limitation of SRM checks

SRM is **post-hoc verification** — it cannot guarantee the correctness of the input data. The script has no way to know whether your `n` is a unique user count or an event count. That responsibility sits in the data collection step.

How to correctly interpret SRM results:

- **SRM passes (p ≥ 0.01):** Based on the `n` values you provided, traffic allocation looks normal — assuming `n` is defined correctly.
- **SRM fails (p < 0.01):** In addition to investigating the traffic split, check whether data collection is correct — a wrong definition of `n` can also trigger an SRM alarm.

> The quality ceiling of the SRM check depends on whether `n` is correctly defined. The script cannot verify this — it can only make the contract explicit in documentation and leave the responsibility with the data collection step.

---

## Chapter 10: Using an Informative Prior

### What is a prior?

A prior is your existing belief about δ **before seeing the experiment data**.

The script supports two modes:

```markdown
prior:
  proper: false   # default: flat prior — posterior is driven entirely by data
  proper: true    # enabled: historical knowledge influences the posterior
  mean:   0.0     # expected direction of lift (0 = no expected direction)
  stddev: 0.3     # plausible range of lift (±30%)
```

---

### When should you use a prior?

**Valid sources: independent information from before the experiment**

- Results from similar past experiments
- Industry knowledge or domain expertise
- External data completely unrelated to this experiment's data

**Invalid source: early data from this experiment**

If you use the first 3 days of the experiment to set a prior, then compute the posterior using all data (including those 3 days) — the early data is used twice. The result is biased toward early noise and is statistically invalid.

---

### "Run 3-5 days first, then start a new experiment using that data as a prior" — is this valid?

**Yes, completely valid. This is the correct approach.** The key requirement is that the two experiments' data must be entirely separate:

```
Experiment A: days 1–5, collect baseline data
  → read from analysis.md: rel Δ = +12%, 95% CI = [+4%, +20%]
  → derive prior parameters:
      mean   = rel Δ = 0.12
      stddev = (ci_upper - ci_lower) / (2 × 1.96)
             = (0.20 - 0.04) / 3.92 ≈ 0.041

Experiment B: reset observation window on day 6
  → input.json contains only data from day 6 onward
  → set in definition.md: proper: true, mean: 0.12, stddev: 0.041
  → prior + new data → posterior
```

Note: `analysis.md` does not output `se` directly — derive it from the 95% credible interval as shown above. `rel Δ` is the same value as μ_rel / δ (delta).

| Situation | Valid? |
|-----------|--------|
| Experiment A data as prior, Experiment B uses fresh data | ✅ Valid |
| First 3 days as prior, posterior computed with all data including those 3 days | ❌ Data used twice |

---

### Actual effect of the prior

| Sample size | Prior influence |
|-------------|----------------|
| Small (n < 200) | Strong — result pulled toward prior mean |
| Medium | Partial shrinkage |
| Large (n > 1000) | Data dominates — prior is nearly irrelevant |

With a large enough sample, results are almost identical with or without a prior. The prior only has a meaningful effect when **samples are small and noise is high**.

---

### Current documentation gaps (to be improved)

The current `analysis-bayesian.md` and `SKILL.md` have two gaps in how they guide users on priors:

| Location | Gap |
|----------|-----|
| `analysis-bayesian.md` | Does not explain how to derive `mean` and `stddev` from historical experiment data |
| `SKILL.md` | Does not ask the user about prior knowledge when creating `definition.md` — the prior is effectively an invisible feature |

The "run 3-5 days first, then start a new experiment" best practice is not mentioned anywhere in the current documentation. Both gaps will be addressed in a follow-up SKILL/reference improvement task after the tutorial is complete.

---

## Learning Progress

- [x] Chapter 1: Why Bayesian?
- [x] Chapter 2: Two metric types (proportion / continuous / inverse)
- [x] Chapter 3: Every variable — definition and calculation (mean, var, μ_rel, se)
- [x] Chapter 4: The posterior distribution N(μ_rel, se²)
- [x] Chapter 5: How P(win) is computed
- [x] Chapter 6: How this relates to Bayes
- [x] Chapter 7: 95% Credible Interval
- [x] Chapter 8: Risk (expected loss)
- [x] Chapter 9: SRM check
- [x] Chapter 10: Using an informative prior
