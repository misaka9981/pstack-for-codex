# Codex agent model and capability profile

Codex custom agents are standalone TOML files in project `.codex/agents/` or user `~/.codex/agents/`. The TOML `name` field, not the filename, owns identity. Skill `agents/openai.yaml` files provide UI and invocation metadata only.

## Role matrix

| Role | Writable scope | Sandbox policy | Connector posture | Skill posture | Model policy | Fallback |
| --- | --- | --- | --- | --- | --- | --- |
| `pstack-poteto-agent` | Inherits the live parent request; setup does not grant writes | Inherits the live runtime so setup cannot broaden authority | Inherits, but use remains limited to the parent request | Must read `poteto-mode`; portable prompt is authoritative | Inherit by default; install an explicit pair only after an observable model list validates both values | Include `poteto-agent-prompt.md` in a generic-agent task; use the parent sequentially when agents are unavailable |
| `pstack-comment-sicko` | None | Explicit `read-only` default; live parent restrictions may narrow it further | Prohibited by prompt; setup does not claim it can prove connector isolation | May use `how` and `why` for read-only investigation | Inherit by default; install an explicit pair only after validation | Use the portable prompt in a deliberately constrained generic agent; otherwise skip and report the missing isolation |
| `pstack-plan` | None | Explicit `read-only` default | Inherits parent authority; no connector authority is added | Bounded planning and design; portable prompt is authoritative | Request `gpt-6-astra` / `high`; write only after observable validation | Use `plan-agent-prompt.md` with a generic read-only agent or plan in the parent |
| `pstack-review` | None | Explicit `read-only` default | Inherits parent authority; no connector authority is added | Independent diff review; portable prompt is authoritative | Request `gpt-6-astra` / `high`; write only after observable validation | Use `review-agent-prompt.md` with a generic read-only agent or review in the parent |
| `pstack-explore` | None | Explicit `read-only` default | Inherits parent authority; no connector authority is added | Codebase exploration; portable prompt is authoritative | Request `gpt-6.1-sol` / `high`; write only after observable validation | Use `explore-agent-prompt.md` with a generic read-only agent or explore in the parent |
| `pstack-code` | Parent-request-only writes | Inherits the live runtime so setup cannot broaden authority | Inherits parent authority; no connector authority is added | Bounded implementation; portable prompt is authoritative | Request `gpt-6.1-sol` / `high`; write only after observable validation | Include `code-agent-prompt.md` in a generic-agent task; use the parent sequentially when agents are unavailable |

Custom-agent defaults never prove the served model, effort, effective sandbox, connector set, or skill availability. A setup receipt describes written configuration only. Runtime receipts must come from an observable Codex surface.

## Model resolution

- No requested pair: omit `model` and `model_reasoning_effort`; both inherit. The existing parent and comment profiles have no requested pair by default.
- A default requested pair for plan, review, explore, or code is intent only, not proof of entitlement.
- Requested pair plus an observable model list: require an exact model match and require the effort in that model's advertised effort set before writing both fields.
- Requested pair without an observable model list: record `unverified-inheritance`, omit both TOML fields, and show the requested pair only as unverified intent.
- Missing entitlement or unsupported pair: stop without changing profiles. Do not silently select a substitute.

Panel workflows must report reduced diversity when inheritance or unavailable profiles collapse distinct requested roles onto the same observable model. They must not invent a served-model receipt.

## Ownership receipt

Schema-v2 receipts record scope, relative path, SHA-256, template source, requested model policy, and configuration-resolution status. A schema-v1 receipt for the original two profiles is accepted only for those two paths. Migration preserves their exact file bytes and model-policy records, then creates only the four missing profiles. An atomic journal stages all six receipt records and new contents before any profile creation. New profiles use exclusive creation; retries accept each path only at its prior receipted hash or staged new hash. Any other state stops without overwrite. Existing profiles do not get replaced during install or upgrade. Uninstall atomically archives receipted profile files instead of deleting them. Files already divergent during inspection stay in place; edits racing with archival are retained in the archive and recorded in its manifest. The receipt is moved last, so an interrupted uninstall can resume from the receipt-keyed archive. To change settings, uninstall and reinstall the profiles.
