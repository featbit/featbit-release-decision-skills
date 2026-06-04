---
name: Multi-Experiment Traffic Patterns
description: Sequential, mutual-exclusion, and orthogonal traffic allocation patterns for running multiple experiments on the same flag or surface.
---

# Multi-Experiment Traffic Patterns

When multiple experiments run on the same product surface, flag, or user pool, the traffic allocation strategy determines whether results are valid. Choose the pattern based on timing and independence.

---

## Pattern 1: Sequential Experiments (Default)

**When to use:** Two or more experiments on the same flag or surface, where each experiment answers a different question and later experiments depend on earlier results.

**How it works:**
- Experiment 1 runs to conclusion (decision made, traffic fully assigned)
- Experiment 2 starts after Experiment 1 ends
- No overlap in observation windows
- Users who participated in Experiment 1 may enter Experiment 2

**Traffic allocation:**
- Each experiment owns 100% of eligible traffic during its window
- No splitting between experiments
- Variant pool may change between experiments (e.g., losing variant removed)

**Why this is the default:**
- Simplest to implement — no mutual-exclusion infrastructure needed
- No risk of interaction effects between experiments
- Each experiment gets maximum available sample size
- Works with any flag system, no layered experiment platform required

**When NOT to use:**
- When experiments must run concurrently due to time pressure
- When each experiment is independent and does not build on the other's results

**Example (from this project):**
- Exp 1 (Bayesian A/B): `disabled` vs `bottom-right` — validates widget effectiveness
- Exp 2 (Bandit): `bottom-right` vs `top-right` vs `inline-docs` — starts only after Exp 1 confirms widget helps; `disabled` variant removed

---

## Pattern 2: Mutual Exclusion (Concurrent, Same Surface)

**When to use:** Two or more experiments must run at the same time on the same product surface or flag, and the treatments might interact.

**How it works:**
- Total eligible traffic is partitioned into non-overlapping slices
- Each experiment receives its own slice — no user appears in more than one experiment
- Partitioning is done by hashing the dispatch key (e.g., `userId`) into buckets

**Traffic allocation:**
- If 2 concurrent experiments need 50% each: split traffic into two halves
- If experiments need unequal sizes: assign proportional slices (e.g., 60/40)
- Holdout group (optional): reserve 5–10% that sees no experiment for baseline comparison

**Tradeoffs:**
- Each experiment gets less traffic → longer time to reach statistical power
- Requires a platform that supports experiment layers or traffic partitioning
- More operationally complex — must coordinate experiment start/end to release buckets

**When NOT to use:**
- When experiments are on different surfaces or flags with no interaction
- When sequential design is acceptable (always prefer sequential if timing allows)

**Implementation note:**
FeatBit supports this via targeting rules with hashed user segments. Create non-overlapping segments (e.g., `hash(userId) % 100 < 50` for Experiment A, `≥ 50` for Experiment B) and assign each segment to its experiment's flag rules.

---

## Pattern 3: Orthogonal Experiments (Concurrent, Independent Surfaces)

**When to use:** Two or more experiments run at the same time but on completely independent features, pages, or user journeys with no shared metrics and no expected interaction.

**How it works:**
- Each experiment uses its **own flag** (different `flagKey`) and targeting rules independently
- A user may be in multiple experiments simultaneously — their assignment in one experiment is independent of their assignment in the other
- No traffic splitting needed — each experiment uses the full eligible pool

**Why different `flagKey` is required:**
The data server hashes `user_key || flagKey` to assign bucket positions. A different `flagKey` produces a different hash, making assignment in experiment A statistically independent of assignment in experiment B — this is what "orthogonal" means. Two experiments that share the same `flagKey` share the same bucket space, and assignment is correlated, not independent.

In this system, a different `flagKey` means a different project. Orthogonal experiments always span multiple projects.

**Traffic allocation:**
- Each experiment allocates traffic independently (e.g., both use the full pool within their respective flag's rollout)
- Users may receive treatment in both, control in both, or mixed — by design

**Tradeoffs:**
- Assumes no interaction between experiments — if this assumption is wrong, results may be confounded
- Faster than mutual exclusion (full traffic available to each experiment)
- Requires validating that no downstream metrics are shared

**When NOT to use:**
- When experiments act on the same UI element, flow, or metric surface
- When one experiment's treatment might influence the other's metric
- When both experiments share the same `flagKey` (use mutual exclusion instead)

---

## System Constraints: One `flagKey` / One Project

This system derives bucket assignment from `hashtext(user_key || flagKey)`. The `flagKey` is the hash seed. `layerId` is a WHERE-clause filter on evaluation records — it does not create an independent hash space.

```
One flagKey / one project
  ├── Concurrent max?       → N mutually exclusive experiments (non-overlapping bucket ranges)
  ├── Cannot do?            → Independent layering / orthogonal (requires different flagKey)
  ├── Recommended form?     → One experiment + primary metric + guardrails
  └── Multiple experiments? → Sequential iteration (Exp1 decides → Exp2 inherits learning)
```

Orthogonal and layered designs always require separate projects.

---

## Decision Checklist

Before starting a second experiment on the same flag or surface:

1. **Can Experiment 2 wait until Experiment 1 concludes?**
   - Yes → use **Sequential** (Pattern 1)
   - No → continue to question 2

2. **Do the experiments affect the same user surface or metric?**
   - Yes → use **Mutual Exclusion** (Pattern 2)
   - No → use **Orthogonal** (Pattern 3)

3. **Is there enough traffic to power both experiments in their allocated slices?**
   - Run sample-size calculation on the reduced traffic pool
   - If insufficient → prefer sequential over underpowered concurrent experiments

---

## Anti-Patterns

**Running concurrent experiments on the same flag without isolation**
Users see a mix of treatments from different experiments. Results are confounded. Neither experiment's results are trustworthy.

**Mutual exclusion when sequential would work**
Wastes traffic by splitting the pool. If the experiments are naturally ordered (validate → optimise), sequential is strictly better.

**Assuming orthogonality without checking**
Two "independent" experiments on different features may still share downstream metrics (e.g., both affect session_duration). Verify metric independence before assuming orthogonality.

**Forgetting to release traffic buckets after an experiment ends**
In mutual exclusion, completed experiments must release their traffic slice back to the pool. Otherwise, available traffic shrinks with each new experiment.
