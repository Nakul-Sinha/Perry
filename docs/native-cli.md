# Native CLI connections

The Claude Code pilot invokes the unmodified native CLI on the runner device. The user signs in through Claude Code itself. Perry never reads or copies its authentication files and does not share account allowances. API connections remain separate and require an explicit selection.

| Connection | Current capability |
| --- | --- |
| Claude Code `2.1.325` on Linux or WSL | Implemented pilot with process and entrypoint fixtures. Live account acceptance remains open. |
| Native Windows or other Claude versions | Unavailable until process, filesystem and protocol behavior is verified. |
| Codex CLI | Unavailable pending a verified startup and tool-isolation profile. |

## Setup

Use a trusted Linux runner account or a checkout in the WSL Linux filesystem. Install Claude Code `2.1.325` using its [official instructions](https://code.claude.com/docs/en/setup). Confirm the version and authenticate yourself:

```sh
claude --version
claude auth login
```

Select an explicit canonical Claude model ID available on that account. Short aliases such as `sonnet` are not accepted. Replace the repository path and full commit IDs:

```sh
pnpm review:local --repo /path/to/repo --base FULL_BASE_SHA --head FULL_HEAD_SHA --claude-cli-model MODEL_ID
pnpm ask:local --repo /path/to/repo --base FULL_BASE_SHA --head FULL_HEAD_SHA --question "Where is total computed?" --claude-cli-model MODEL_ID
```

The same flag works with `pnpm review:fixture` and `pnpm runner:serve`. A co-located control service selects this route with `PERRY_CLAUDE_CLI_MODEL`. In remote mode, select it on the paired runner. Leave other model settings unset.

Preflight verifies the exact CLI version and native account status before source assessment. An unsupported platform, missing native login or mismatched model produces an explicit incomplete result. There is no automatic API fallback. Native account eligibility and payment remain between the user and the provider. Anthropic documents unmodified native CLI integrations and applicable terms in its [integration guidance](https://code.claude.com/docs/en/legal-and-compliance).

## Execution boundary

Each invocation starts in a fresh private empty directory outside the reviewed repository. Only bounded source text enters stdin. Restricted and safe modes skip ordinary project and user customizations; every tool is denied, configured MCP servers are excluded, session persistence is disabled, and no reviewed source is executed by the model process. Investigator and verifier use separate processes and conversations. The subprocess environment excludes API keys and routing overrides.

Administrator-managed policy is part of the trusted runner host. Safe mode and ordinary hook settings cannot disable all administrator-managed hooks or commands. Configure that policy for this use before enabling the pilot. This mode does not claim to sandbox a hostile CLI installation or a hostile host administrator. See the [CLI reference](https://code.claude.com/docs/en/cli-reference) and [managed settings](https://code.claude.com/docs/en/settings-reference).

Perry bounds input, combined stdout/stderr, final result size and command deadlines. Cancellation terminates the owned POSIX process group and removes the temporary directory. Perry validates the native result envelope, actual model and route before applying its normal citation and verifier checks. CLI-reported model token counts are partial accounting, not a subscription usage meter or a currency budget. Native client diagnostics and provider retention remain subject to their own configuration and terms.

## Acceptance still required

Automated tests use a simulated installed CLI and synthetic source. They verify invocation restrictions, process cleanup, malformed output, model mismatch and the public Perry commands. No live subscription assessment has been run during development. Record a maintainer-authorized call, actual model, route and outcomes in [issue #7](https://github.com/Nakul-Sinha/Perry/issues/7) before calling the connection live-verified.

The Codex route remains gated because its individual feature switches have not established a complete tool and startup isolation contract. Its current local Windows installation also needs a working platform dependency before read-only preflight. Keep authentication within the native provider flow; do not extract cached credentials or substitute an API route without the owner's explicit selection.
