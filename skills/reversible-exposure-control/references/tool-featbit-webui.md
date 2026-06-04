---
name: Tool Adapter: FeatBit Web UI
description: FeatBit web UI operations: when to use, targeting rules setup, multi-variant flag configuration, and audit trail review.
---

# Tool Adapter: FeatBit Web UI

**Vendor:** FeatBit  
**Tool type:** Web UI (browser, FeatBit management console)  
**Default for skill:** `reversible-exposure-control`

The FeatBit web UI is the complete management interface — it covers every flag operation (create, enable, disable, rollout, targeting, archive, delete) plus capabilities that only exist in the UI (multi-variant editors, targeting rule chains, sendToExperiment, audit trail, RBAC). [tool-featbit-cli.md](tool-featbit-cli.md) provides an automation-friendly subset of these same operations for use in terminals and agent workflows.

## TOC

- [When to Use the Web UI](#when-to-use-the-web-ui)
- [Operations Reference](#operations-reference)
- [Targeting Rules](#targeting-rules)
- [Multi-Variant Flags](#multi-variant-flags)
- [Audit Trail and Compliance](#audit-trail-and-compliance)

---

## When to Use the Web UI

| Situation | Use |
|---|---|
| Fine-grained targeting rules (segments, attribute conditions, multi-rule chains) | Web UI |
| Multi-variant flags (string, number, JSON variation types) | Web UI |
| Experiment configuration (sendToExperiment for A/B data collection) | Web UI |
| Audit trail review — who changed what and when | Web UI |
| RBAC management — who can operate flags in production | Web UI |
| Scripted flag create / enable / disable / rollout percentage | CLI |
| Flag state inspection before deployment | CLI |
| Flag evaluation testing against a specific user | CLI |

---

## Operations Reference

| Operation | Web UI location |
|---|---|
| Create a feature flag | Feature Flags → New Flag |
| Add variants (control / treatment values) | Flag detail → Variations |
| Configure multi-variant type (string, number, JSON) | Flag detail → Variations → type selector |
| Set percentage rollout | Flag detail → Targeting → Percentage rollout |
| Add individual user targeting rules | Flag detail → Targeting → Individual rules |
| Add segment targeting | Flag detail → Targeting → Segment rules |
| Add custom attribute rules | Flag detail → Targeting → Attribute conditions |
| Configure sendToExperiment | Flag detail → Targeting → sendToExperiment |
| Enable the flag | Flag list toggle or Flag detail toggle |
| Disable (rollback) the flag | Same toggle — all users revert to the off value immediately |
| Archive a flag | Flag detail → Archive |
| View audit trail | Flag detail → Activity tab |
| Manage team permissions | Settings → Members → Roles |

---

## Targeting Rules

Targeting rules define which users see a specific variation before percentage rollout applies. Rules are evaluated top-to-bottom — the first matching rule wins.

**Common rule types:**
- **Individual user** — match by user key (e.g., internal testers, stakeholders before launch)
- **Segment** — match users in a predefined segment (e.g., beta group, paying customers)
- **Custom attribute** — match on a user property such as `plan`, `country`, or `region`

**Setup order:**
1. Set targeting rules first (while flag is still OFF)
2. Verify rules cover protected audiences (who must NOT see the candidate)
3. Set rollout percentage to initial value (5–10%)
4. Enable the flag

Protected audiences that must NOT see a new variant should be in an individual rule returning the default OFF variant. This rule must be placed above the rollout rule.

---

## Multi-Variant Flags

Boolean flags (on/off) cover most rollout scenarios. Use multi-variant flags when:
- Testing UI copy — multiple text variants, one per user group
- A/B/n testing with more than two groups
- Configuration-style flags that return a string or JSON value

In the web UI: **Flag detail → Variations** to add or edit variants. Each variant requires a unique key that matches the value checked in the code:

```js
// Boolean flag
const enabled = client.variation("my-flag", false);

// Multi-variant flag
const layout = client.variation("checkout-layout", "default");  // returns "default", "compact", or "expanded"
```

---

## Audit Trail and Compliance

Every change made through the web UI is recorded with:
- Timestamp
- Acting user (authenticated identity)
- Change description (field modified and old/new value)

To view: **Flag detail → Activity tab**

This audit log matters when:
- Investigating an incident (who enabled this flag in production, and when?)
- Compliance review (was this change authorized by the right role?)
- Change management processes that require traceable approvals

CLI operations (`flag toggle`, `flag set-rollout`, `flag create`) also record changes in the audit trail when using the management API token. The acting identity is the token owner — ensure each team member uses their own token rather than a shared one.
