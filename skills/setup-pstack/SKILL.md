---
name: setup-pstack
description: "Install, update, remove, or inspect optional Codex agent profiles for pstack, including explicit model-role configuration. Use for setup-pstack or requests to configure pstack agents and models."
---

# Setup pstack for Codex

Install optional custom-agent profiles without making them part of the plugin manifest. Codex loads project profiles from `.codex/agents/*.toml` and user profiles from `~/.codex/agents/*.toml`. This skill's `agents/openai.yaml` is UI metadata only.

Read `references/model-profile.md` before changing configuration. The portable prompts in the owning skills remain authoritative and work without installed profiles.

## Safety contract

- Require explicit user intent for install, upgrade, or uninstall.
- Ask for `project` or `user` scope when it is not clear. Project scope is the safer default only when the user says to configure the current repository.
- Scan both project and user agent directories before a write. Stop on duplicate TOML `name` fields regardless of filename or layer.
- Never overwrite another owner. Preserve receipted profile bytes during install or upgrade. Create new profiles exclusively.
- Install and upgrade stop on a modified, missing, or relocated receipted file; leave profiles and receipt untouched. Uninstall atomically moves hash-matching profiles into a receipt-keyed archive instead of deleting them. Archive destinations must be real directories with a matching ownership manifest; symlinks and pre-existing unowned paths stop the operation before any profile moves. Profiles already divergent at inspection stay in place. If a concurrent edit lands between inspection and archival, the changed bytes are retained in the archive and called out in its manifest. The receipt is archived last; an interrupted uninstall resumes from the archive.
- Install and uninstall share a PID lock. A simultaneous operation is refused; retry after the active operation completes. A lock left by a terminated process can be recovered after that PID is confirmed absent.
- Configuration is not runtime proof. Never claim the served model, effort, effective permissions, connector set, or skill availability unless a supported live surface reports it.

## Model policy

New installs request `gpt-6-sol` with `medium` for `pstack-plan` and `pstack-review`, and `gpt-6-luna` with `xhigh` for `pstack-explore` and `pstack-code`. The original `pstack-poteto-agent` and `pstack-comment-sicko` profiles inherit the parent by default. Requested defaults are not entitlement evidence. A profile JSON value of `null` explicitly selects parent inheritance; a pair overrides that role's default request. Existing receipted profiles keep their exact TOML bytes and model policy during migration or reinstall.

If a supported Codex model-list surface is observable, convert it to JSON records shaped like:

```json
[{"slug":"gpt-6-sol","reasoning_efforts":["medium"]},{"slug":"gpt-6-luna","reasoning_efforts":["xhigh"]}]
```

Validate both values before writing them. If no supported model list is observable, do not guess or accept pasted entitlement claims as proof: omit both TOML fields, inherit the parent, and record `unverified-inheritance` with the requested pair in the receipt. Never write a hardcoded unverified pair to TOML. A missing model or unsupported effort is a hard stop; let the user choose another pair or inheritance.

Profiles are a JSON object keyed by namespaced agent name:

```json
{
  "pstack-poteto-agent": {"model":"gpt-6-sol","reasoning_effort":"high"},
  "pstack-comment-sicko": null,
  "pstack-plan": {"model":"gpt-6-sol","reasoning_effort":"medium"},
  "pstack-review": {"model":"gpt-6-sol","reasoning_effort":"medium"},
  "pstack-explore": {"model":"gpt-6-luna","reasoning_effort":"xhigh"},
  "pstack-code": {"model":"gpt-6-luna","reasoning_effort":"xhigh"}
}
```

Omitting a role uses its default. Set the role to `null` to inherit the parent. Existing profiles are immutable during install or upgrade; uninstall and reinstall to change their settings.

## Execute

The helper is `scripts/manage-agents.mjs` relative to this skill.

```text
node scripts/manage-agents.mjs scan --project-root <repo> --user-home <home>
node scripts/manage-agents.mjs install --scope project --project-root <repo> --user-home <home>
node scripts/manage-agents.mjs install --scope user --project-root <repo> --user-home <home>
node scripts/manage-agents.mjs uninstall --scope project --project-root <repo> --user-home <home>
```

Add `--profile <json-file>` for requested pairs and `--models <json-file>` only when the list came from an observable supported surface. Do not create temporary files containing secrets; these files contain model identifiers only.

On success, report the scope, written paths, receipt path, and each role's configuration status. Existing profile bytes and model policies are preserved. To change a profile's settings, uninstall it and install again. New profiles are created exclusively and never replace a concurrent file. The schema-v2 receipt upgrades a valid schema-v1 two-role receipt. An atomic migration journal lets a retry finish interrupted profile creation; a file that matches neither its old receipt nor its staged new hash stops recovery without being overwritten. Uninstall archives profile bytes and the receipt under `.codex/pstack-for-codex-agent-archives/` (project scope) or `~/.codex/pstack-for-codex-agent-archives/` (user scope). The manifest records concurrent edits and missing files; review the archive before manually purging it. Say that new profiles apply to newly spawned agents. When a panel inherits or loses distinct profiles, report reduced model diversity instead of claiming which model served it.

On `review-required` or any collision, stop. Show the exact paths and do not suggest force deletion.
