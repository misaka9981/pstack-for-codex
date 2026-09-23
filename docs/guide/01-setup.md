# Set up pstack

This tutorial installs the plugin, checks skill discovery, and runs one representative skill.

## Install the public marketplace

Install the marketplace directly from the public GitHub repository:

```bash
codex plugin marketplace add misaka9981/pstack-for-codex
codex plugin add pstack-for-codex@pstack-for-codex-local
codex plugin list --json
```

For development, pass the absolute checkout path to `codex plugin marketplace add`. Start a new Codex task after installation so the task receives the refreshed skill catalog.

`codex plugin list --json` confirms the plugin installation, but Codex CLI `0.146.0` has no offline runtime skill-index command. The prompt below is the manual prompt-time discovery check; the automated release smoke validates the catalog files in the installed artifact without claiming model dispatch.

## Check one skill

Open a repository and ask for a read-only trace:

```text
$how explain how this repository validates plugin metadata.
```

Codex resolves `$how` to the installed `pstack-for-codex` namespace. The response should cite code paths and separate observed behavior from inference.

## Install optional agent profiles

The plugin works without custom profiles. To add all six optional profiles, run:

```text
$setup-pstack install the pstack agents for this project.
```

Choose `project` or `user` scope when asked. Project scope writes `.codex/agents/*.toml`. User scope writes `~/.codex/agents/*.toml`. Setup scans both locations for duplicate agent names and refuses to overwrite unowned files.

New installs request gpt-6-sol/medium for plan and review, and gpt-6-luna/xhigh for explore and code. The original Poteto and Comment Sicko profiles inherit the parent model by default. Setup writes a requested pair only when a supported live model list proves both values. If the model list is unavailable, setup records `unverified-inheritance` and omits both TOML fields. Migration preserves existing v1 profile bytes and model requests. It adds only the four missing profiles when both old files still match their receipt. An interrupted migration resumes from its journal if no file has diverged; otherwise setup stops and preserves all files for review.

The result includes the written paths, receipt path, hashes, and configuration status. New profiles apply to agents spawned after installation.

## Remove or upgrade owned profiles

Invoke `$setup-pstack` with an explicit action and scope:

```text
$setup-pstack inspect the project profiles and their receipt.
$setup-pstack upgrade the project profiles.
$setup-pstack uninstall the project profiles.
```

Upgrade stops when a receipted file is changed or missing. Uninstall archives the receipt and hash-matching profiles by atomic rename instead of deleting them. Files already changed at inspection remain in place; a concurrent edit that races with archival is retained in the archive and recorded in its manifest. Review the archive before manually removing it.

Next: [Route work through `$poteto-mode`](./02-poteto-mode.md).
