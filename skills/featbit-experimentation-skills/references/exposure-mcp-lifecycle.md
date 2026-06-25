---
name: exposure-mcp-lifecycle
description: Required FeatBit MCP lifecycle for creating, binding, reading back, and targeting feature flags during CF-03/04 exposure control.
---

# Exposure MCP Lifecycle

Use this reference during CF-03/04 whenever FeatBit feature-flag MCP tools are available.

## Principle

The release-decision experiment record is not the feature flag. It may store the chosen `flagKey`, rollout intent, and constraints, but FeatBit is the source of truth for whether the flag exists and which variations are real.

Do not treat a flag as bound just because a key is present in `constraints`.

## State Machine

1. **Draft contract**
   - Collect flag name, key, type, default/off behavior, control variation, treatment variation, protected audience, initial rollout, rollback trigger, and dispatch key.
   - Do not call create/update tools until required fields are concrete.

2. **Read existing flag**
   - Call `featbit_release_decision_get_feature_flag` with `experimentId` and `key`.
   - If it succeeds, use the returned flag key, revision, variations, and targeting as truth.

3. **Create missing flag**
   - If read returns `ResourceNotFound`, call `featbit_release_decision_create_feature_flag` with the completed flag contract.
   - Immediately call `featbit_release_decision_get_feature_flag` again.
   - If the second read still returns `ResourceNotFound`, stop and report that FeatBit did not create or expose the flag yet. Do not advance Exposure.

4. **Bind actual variations**
   - Map control/treatment from the returned flag variations.
   - If requested variations are absent or have different keys, ask whether to use the actual variations or update the flag. Do not invent variation keys.

5. **Apply targeting / rollout**
   - Call `featbit_release_decision_update_feature_flag_targeting` with the latest `revision` and a complete targeting object.
   - Direct update is the default.
   - Use change-request mode only when reviewer ids are supplied, approval is explicitly requested, or policy requires it.

6. **Persist release-decision state**
   - Only after the flag read/create/read path succeeds, write `constraints` through `featbit_release_decision_update_experiment`.
   - Include the actual flag key, actual variation keys, rollout rule summary, rollback trigger, protected audience, and whether targeting was directly updated or sent as a change request.

7. **Advance**
   - Set stage to `implementing` only after the flag exists and the experiment state references the actual FeatBit flag.

## Resume Behavior

When resuming in the middle of Exposure:

- If `constraints.flagKey` exists, read the flag first.
- If read succeeds, reconcile state with actual flag variations and targeting.
- If read returns `ResourceNotFound`, treat the stored key as a proposed key, not a binding. Re-enter the create-missing-flag path.
- If the contract is incomplete, ask for the missing field before creating the flag.

## Completion Gate

Exposure is complete only when:

- `get_feature_flag` succeeds for the selected key.
- Actual variations are known and mapped to control/treatment.
- Initial targeting or rollout is defined in FeatBit or queued as an explicit change request.
- Rollback action is explicit.
- `constraints` has been updated from the actual flag response, not only from user prose.
