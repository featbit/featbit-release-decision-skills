---
name: Skill Routing Guide
description: CF-01 through CF-08 routing table mapping control lenses to satellite skills, with entry conditions and handoff rules.
---

# Skill Routing Guide

Maps each CF trigger to its implementation skill. Read this when routing to a downstream skill.

## CF-01 → intent-shaping

**Activate when:** goal is vague, user mixes goal with tactic, outcome is undefined.  
**Skill:** `intent-shaping`  
**Entry signal:** user has a direction but not a measurable outcome.

## CF-02 → hypothesis-design

**Activate when:** goal is clear but no falsifiable causal claim exists.  
**Skill:** `hypothesis-design`  
**Entry signal:** user is ready to build but hasn't stated what they expect to happen and why.

## CF-03 + CF-04 → reversible-exposure-control

**Activate when:** a change is about to be built or deployed, or a rollout strategy is needed.  
**Skill:** `reversible-exposure-control`  
**Entry signal:** "I want to ship", "start rolling out", "create a feature flag", "who should see this first", "help me write the flag handoff for dev".

## CF-05 → measurement-design

**Activate when:** user asks how to measure success, defines too many metrics, or hasn't defined events.  
**Skill:** `measurement-design`  
**Entry signal:** "how do I know it worked", "what should I track", "what's the primary metric".

## CF-05 (after) → experiment-workspace

**Activate when:** instrumentation is confirmed and data needs to be collected and calculated.  
**Skill:** `experiment-workspace`  
**Entry signal:** "start the experiment", "set up data collection", "run the analysis", "pull the results", "do we have enough data yet".  
**Note:** This skill owns the experiment database record, the data collection, and the analysis scripts. It produces `analysisResult` in the experiment record which is the input to `evidence-analysis`.

## CF-06 + CF-07 → evidence-analysis

**Activate when:** `analysisResult` exists in the experiment record and a decision is being considered.  
**Skill:** `evidence-analysis`  
**Entry signal:** "analyze results", "should I ship this", "is this significant", "continue or rollback".

## CF-08 → learning-capture

**Activate when:** a cycle ends, regardless of outcome.  
**Skill:** `learning-capture`  
**Entry signal:** "we're done with this experiment", "close this out", "what did we learn", "next iteration".

---

## Multiple CFs Active Simultaneously

This is normal. A user saying "we shipped a new onboarding flow last week and want to know if it's working" activates CF-06 (evidence sufficiency) and may surface CF-05 gaps (measurement design) at the same time.

Activate skills in the order that unblocks the user soonest. If measurement is incomplete, go to `measurement-design` before `evidence-analysis`.
