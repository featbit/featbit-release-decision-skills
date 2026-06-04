---
name: Tool Adapter: FeatBit CLI
description: FeatBit CLI (.NET 10): config management, flag list/create/toggle/archive/set-rollout/evaluate commands, and SDK integration via featbit-skills.
---

# Tool Adapter: FeatBit CLI

**Vendor:** FeatBit  
**Tool type:** CLI (.NET 10)  
**Default for skill:** `reversible-exposure-control`

The FeatBit CLI provides automation-friendly access to a subset of operations that are also available in the FeatBit web UI: config management, flag inspection, and flag management (create, toggle, archive, rollout, evaluate). The web UI is the complete management interface and can do everything the CLI can do plus more — see [tool-featbit-webui.md](tool-featbit-webui.md). Use the CLI when you need scripted, pipeline, or agent-driven flag operations without opening a browser.

## TOC

- [Prerequisites](#prerequisites)
- [Inspect Operations](#inspect-operations)
- [Flag Management Commands](#flag-management-commands)
- [Evaluate Flags](#evaluate-flags)
- [SDK Integration in Code](#sdk-integration-in-code)

---

## Prerequisites

Build from source (requires .NET 10 SDK) or download a pre-built binary. See [github.com/featbit/featbit-cli](https://github.com/featbit/featbit-cli) for installation steps.

Initialize config once:

```bash
featbit config init        # interactive — prompts for host, access token, org ID
featbit config validate    # confirm credentials work before using other commands
featbit config show        # display current config (token masked)
featbit config set --token api-new-token   # update a single field non-interactively
featbit config clear                       # remove the saved config file
```

Config is stored outside the repository:
- Windows: `%APPDATA%\featbit\config.json`
- macOS: `~/Library/Application Support/featbit/config.json`
- Linux: `~/.config/featbit/config.json`

Environment variable overrides (take precedence over config file): `FEATBIT_HOST`, `FEATBIT_TOKEN`, `FEATBIT_ORG`

Default host if none provided: `https://app-api-experimentation.featbit.co`

All business commands accept `--host`, `--token`, and `--org` to override saved config on a single call without writing to disk.

---

## Inspect Operations

Use these commands to look up IDs and verify state.

### List projects

```bash
featbit project list           # table output
featbit project list --json    # JSON output
```

### Get a project and its environments

```bash
featbit project get <experiment-id>
featbit project get <experiment-id> --json
```

Returns project name, key, and all environment IDs. **Environment IDs are required for all flag commands.**

### List feature flags in an environment

```bash
featbit flag list <env-id>                                    # first 10 flags (default page)
featbit flag list <env-id> --all                              # all flags across all pages
featbit flag list <env-id> --name my-feature                  # filter by name/key (partial match)
featbit flag list <env-id> --page-index 1 --page-size 20      # paginate
featbit flag list <env-id> --json                             # JSON output
```

JSON output shape:

```json
{
  "data": {
    "totalCount": 5,
    "items": [
      { "id": "...", "key": "...", "name": "...", "isEnabled": true, "variationType": "boolean", "tags": [] }
    ]
  }
}
```

---

## Flag Management Commands

These commands create or mutate flags directly via the FeatBit management API.

### Create a feature flag

```bash
featbit flag create <env-id> --flag-name "My Feature" --flag-key my-feature
featbit flag create <env-id> --flag-name "My Feature" --flag-key my-feature --description "Controls X"
```

Creates a boolean flag in the OFF state. Naming conventions:
- Use kebab-case for keys: `new-checkout-flow`, not `NewCheckoutFlow`
- Include context: `onboarding-progress-bar`, not `progress-bar`
- Flag key is environment-agnostic — same key is used across staging and production

### Enable or disable a feature flag

```bash
featbit flag toggle <env-id> <flag-key> true    # enable
featbit flag toggle <env-id> <flag-key> false   # disable (immediate rollback)
```

Disabling sets all users to the off variation immediately.

### Set rollout percentage

```bash
featbit flag set-rollout <env-id> <flag-key> --rollout '<json>'
featbit flag set-rollout <env-id> <flag-key> --rollout '<json>' --dispatch-key userId
```

`--rollout` accepts a JSON array of rollout assignments. See [github.com/featbit/featbit-cli](https://github.com/featbit/featbit-cli) for the exact schema. `--dispatch-key` sets the user attribute used to allocate traffic consistently (default: user key).

### Archive a feature flag

```bash
featbit flag archive <env-id> <flag-key>
```

Archives a flag after it is fully removed from code. Archived flags are no longer evaluated.

---

## Evaluate Flags

Evaluate one or more flags for a specific user. This calls the evaluation API (not the management API) and requires the environment SDK secret, not the management access token.

```bash
featbit flag evaluate --user-key <user-id> --env-secret <sdk-secret>
featbit flag evaluate --user-key alice --env-secret <sdk-secret> --user-name "Alice"
featbit flag evaluate --user-key alice --env-secret <sdk-secret> --flag-keys "flag-a,flag-b"
featbit flag evaluate --user-key alice --env-secret <sdk-secret> --custom-props '{"plan":"pro"}'
featbit flag evaluate --user-key alice --env-secret <sdk-secret> --tags beta --tag-filter all
```

Use `--host` (or `FEATBIT_HOST`) to point to a self-hosted evaluation endpoint. Output is a table of flag key → variation → match reason, or `--json` for machine-readable output.

---

## SDK Integration in Code

A feature flag has no effect unless a `variation()` call exists in the codebase. Reversibility requires both the flag in FeatBit and the flag check in code.

To add flag evaluation to an existing codebase, install the FeatBit SDK skills for the relevant language:

```bash
npx skills add featbit/featbit-skills
```

The installer auto-detects your agent (Claude Code, GitHub Copilot, Cursor, Windsurf) and lets you select which skills to install. Choose the SDK skill for your language:

| Skill name | Language / framework |
|---|---|
| `featbit-sdks-dotnet` | C# / ASP.NET Core |
| `featbit-sdks-node` | Node.js / TypeScript |
| `featbit-sdks-python` | Python |
| `featbit-sdks-java` | Java / JVM |
| `featbit-sdks-go` | Go |
| `featbit-sdks-javascript` | Browser JavaScript |
| `featbit-sdks-react` | React / Next.js |
| `featbit-sdks-react-native` | React Native / Expo |

To install a single skill directly:

```bash
npx skills add featbit/featbit-skills --skill featbit-sdks-node
```

Source: [github.com/featbit/featbit-skills](https://github.com/featbit/featbit-skills)
