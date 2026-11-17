# GitHub control pilot

The control service is an operator-configured pilot for one GitHub App installation and one repository. It connects signed general-conversation mentions to the existing local review and question commands. It is not the complete installation, runner-pairing, or readiness service described in the implementation plan.

Automated tests simulate GitHub responses. Live private-installation acceptance is still tracked in [#6](https://github.com/Nakul-Sinha/Perry/issues/6); live Anthropic acceptance is separate in [#5](https://github.com/Nakul-Sinha/Perry/issues/5). Do not treat either as verified by the other.

## Supported requests

Post a new general conversation comment beginning with a direct address:

```text
@Perry review
```

In an open PR, that exact command starts a review and updates the two owned summary/findings comments. Case-insensitive `@Peryy` is also accepted. Other addressed text is a question:

```text
@Perry where is TAX_RATE defined?
```

PR questions inspect the PR head. The pilot skips PR requests when the PR is no longer open. Questions in an ordinary issue inspect its repository's default-branch commit. Without a configured model, the answer lists matching committed source excerpts; it is a bounded search, not a general explanation engine. The selected API route can answer using those excerpts and validated citations. An issue comment asking exactly `@Perry review` gets a clarification to select a PR.

Only `issue_comment` events with action `created` are processed. The mention must start the direct comment, allowing up to three leading spaces or initial blank lines. Quoted/fenced examples, inline review-thread comments, edits, bots, and empty requests do not trigger work. `@Perry review this PR` is a question rather than the exact review command. Effective repository write, maintain, or admin access is required; installation and comment ownership are checked again before publication.

## Operator prerequisites

- Git and Node.js 24, with dependencies installed using the repository's pinned pnpm version.
- A dedicated PostgreSQL database. Startup creates the pilot's `perry_deliveries`, `perry_mentions`, `perry_slots`, and `perry_review_watches` tables; the configured database role needs that access.
- A development GitHub App installed on the selected repository. The pilot needs Metadata read, Contents read, Pull requests read, and Issues write for source and comments. Readiness observation also uses Checks read and Commit statuses read. Missing observation access leaves readiness unknown.
- A maintainer-selected HTTPS webhook endpoint forwarding `/webhooks/github` to the local service. The service binds only to `127.0.0.1`; it does not provision a public endpoint or TLS termination.
- An operator-owned cache directory outside repositories being reviewed, with restricted filesystem access and an appropriate disk quota.

Subscribe the development App to issue comments. This pilot polls CI and review metadata; it does not consume push, CI, approval, or installation-lifecycle events. The broader permission/event list in `plan.md` describes later work.

## Configuration

Supply configuration through the trusted process environment. Keep actual access values, private key files, database connection details, and signing values out of Git, PR comments, logs, and public issues. The service does not automatically load a `.env` file or provide a setup UI.

| Name | Purpose |
|---|---|
| `DATABASE_URL` | Connection for the dedicated PostgreSQL database. |
| `PERRY_APP_ID` | Numeric development App ID. |
| `PERRY_BOT_ID` | Numeric ID of that App's bot account, used to verify comment ownership. |
| `PERRY_APP_KEY_FILE` | Path to the App private key file, outside the checkout/cache/test environment. |
| `PERRY_WEBHOOK_SECRET` | The signing value configured for the App webhook. |
| `PERRY_INSTALLATION_ID` | Numeric installation ID accepted by this process. |
| `PERRY_REPOSITORY_ID` | Numeric repository ID accepted by this process. |
| `PERRY_CACHE_DIR` | Operator-owned local cache root. |
| `PERRY_TEST_PATH` | Optional operator-selected `.test.mjs` path for each PR review on a rootless Linux host. |
| `PERRY_TEST_MODULE` | Optional `.mjs` dependency imported by that test, relative to the repository root. |
| `PERRY_EXECUTION_MODE` | `local` by default, or `remote` for a paired outbound runner. |
| `PERRY_PORT` | Optional localhost port, default `3000`. |
| `PERRY_DAILY_ASSESSMENT_LIMIT` | Optional limit from `1` to `1000000` admitted assessments per UTC day for this repository. Unset means unlimited. |
| `PERRY_ANTHROPIC_MODEL` | Select Anthropic Messages with `ANTHROPIC_API_KEY`. |
| `PERRY_OPENAI_MODEL` | Select OpenAI Responses with `OPENAI_API_KEY`. |
| `PERRY_OPENCODE_CHAT_MODEL` | Select OpenCode Console Chat Completions with `OPENCODE_API_KEY`. |
| `PERRY_CLAUDE_CLI_MODEL` | Select the native Claude Code pilot on the Linux/WSL host with its own supported login. |

Configure at most one model variable. Start with all model variables unset for static reviews and excerpt answers. Supply the chosen API route's key privately in the service environment. The runner receives only that route's key. The native Claude route uses its own login and receives no API keys. See the [native CLI guide](native-cli.md) for its version, platform and account restrictions. Provider selection applies to both reviews and questions.

The allowlist is one installation/repository pair per process. Other signed installation/repository events are not queued. Changing the allowlist does not migrate another installation's pending work or grant access to it.

### Daily assessment allowance

When a daily limit is configured, PostgreSQL reserves one admission after requester authorization and source revision selection, before source acquisition or remote dispatch. Reviews and questions share the allowance, including static assessments. Concurrent requests cannot exceed the configured daily count. Replaying a stored assessment or the same admitted request does not reserve again. Reservations remain charged if later assessment fails or is canceled.

Exhaustion publishes provisional `HOLD | 0/10` with a reason, or a separate question reply, without starting assessment work. An accounting failure also stops assessment. Post a new mention after the UTC reset or an operator limit increase; redelivery preserves the original result. Unlimited mode does not record admissions. These counts are assessment admissions, not tokens, model calls, subscription usage or a currency budget.

Inspect the current UTC count using only database and installation/repository configuration:

```sh
pnpm dev:control --usage
```

The command reports admissions recorded while a limit was enabled and the currently configured limit. It does not need App or provider setup. Changing the limit applies to new admission decisions; already admitted requests remain eligible for recovery.

Start from the repository root after configuring the process:

```sh
pnpm install --frozen-lockfile
pnpm dev:control
```

Or build first and use the packaged entry point:

```sh
pnpm build
pnpm --filter @perry/control start
```

Both workspace apps must remain together because control invokes the matching runner entry point. The default local worker runs on the service host. Set `PERRY_EXECUTION_MODE=remote` to dispatch assessments to a [paired runner](runner-pairing.md). Closing the service stops new intake; PostgreSQL preserves accepted pending work for restart.

## Health and accepted work

- `GET /health/live` returns `200` when the HTTP process can respond.
- `GET /health/ready` returns `200` when its database query succeeds and `503` when unavailable. It does not validate the App, webhook endpoint, repository access, model, or billing account.
- `POST /webhooks/github` validates the raw-body signature and delivery identity. An accepted matching mention is persisted before acknowledgment. Invalid signatures are rejected; a persistence error remains retryable.

An accepted webhook response is not proof of requester authorization, a successful model call, or published comments. The worker rechecks current installation scope, repository identity, effective user permission, and the original comment's current intent. An edited/deleted request or revoked access can be skipped rather than assessed.

## Source and result behavior

The worker resolves full base/head IDs from an open PR or the default branch for issue questions. It fetches into a Perry-owned bare cache under the configured installation/repository scope and verifies the pinned objects. It uses repository-scoped read-only source access for acquisition and strips that access before starting the local runner.

The local runner reads committed source. Static review is the default. An operator can set `PERRY_TEST_PATH` and optionally `PERRY_TEST_MODULE` in the service environment to exercise a specific runtime check on PR reviews. For example, `tests/total.test.mjs` can import `../src/total.mjs` when `src/total.mjs` is the chosen module. Use a non-root Linux service account, rootless Podman with cgroup v2, and the preloaded Node image listed in the README. Each revision gets a separate container with private temporary storage, disabled networking, and no host mounts. Test output records the outcome for each pinned revision. An unavailable runtime, missing file, or missing dependency limits what the result establishes. Only a PR with a verified head in the installed repository can run this profile. Fork and unavailable head repositories get source review and an explicit skipped-check note. PR comments cannot choose paths or commands. Questions only read source.

PR reports include a numeric rating and either `HOLD` or `DO NOT MERGE`. Before final publication, control observes mergeability, draft/review state, active branch rulesets, and required checks on the effective head or test-merge commit. A verified required failure or conflict can tighten an assessed review to `DO NOT MERGE` with a score capped at 4. Failed or wholly unassessed reviews keep provisional `HOLD | 0/10`. Missing permissions, ambiguous reruns and incomplete check inventories remain explicit gaps.

Classic branch protection and all actor-specific merge restrictions are not verified. Successful observed checks cannot establish the full required-check inventory or all prerequisites, so the pilot never recommends `MERGE`. Readiness changes retain source findings and coverage; they cannot complete a partial source assessment. No Administration permission is added for classic protection. See GitHub's [required-check behavior](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks), [branch rules](https://docs.github.com/en/rest/repos/rules#get-rules-for-a-branch), [check access](https://docs.github.com/en/rest/checks/runs#list-check-runs-for-a-git-reference), and [status access](https://docs.github.com/en/rest/commits/statuses#list-commit-statuses-for-a-reference).

While the service is running, a published review becomes due for a metadata check every five minutes. Queue load and GitHub backoff can delay it. A changed base, changed head, or closed PR sets the existing summary to provisional `HOLD | 0/10` and marks its findings stale. Perry records the reviewed and observed commits. An interrupted update resumes on the same two comments. Request a new review to assess updated source. Questions keep their own replies.

For unchanged commits, new CI or review facts update only the summary from the immutable source assessment, without fetching source or calling a model. A recovered CI check can restore the original source score while preserving source blockers and unknown prerequisites. An unchanged fact fingerprint skips publication. Each published revision identifies the observation time and effective check commit. Uncertain writes retain their exact body and comment ID across restart and block newer reviews until reconciled. Maintenance rechecks the installation, repository, owned comment and source revisions; it continues if the original human mention was later edited or deleted.

## Reruns and interrupted publication

A new direct `@Perry review` comment requests a new assessment of current commits. The existing owned summary/findings slots are reused. Redelivering the same event or request does not create another assessment. A question uses a separate answer slot per triggering comment.

The worker persists an assessment before publishing its final comments. It sets the summary to provisional HOLD, writes findings, and then writes the final summary after another freshness check. Stored App ownership and slot markers identify existing comments; user-authored lookalike markers cannot be adopted.

Failures retry with bounded backoff, up to five attempts. A failed oldest request quarantines that thread, so newer requests cannot overtake an uncertain old publication. Other threads can continue. A process restart resumes pending work using recorded results and comment receipts where available.

If a write timed out after reaching GitHub, recovery looks for the matching owned receipt before creating a comment. When a previous creation intent has no visible receipt, the pilot stops rather than blindly posting another comment. An operator must inspect the actual App-owned comments and recorded state before retrying. Do not delete slot records or manually clear creation intent just to bypass the duplicate-write guard.

After fixing the underlying problem and reconciling the external write, queue an existing failed request with:

```sh
pnpm dev:control --retry INSTALLATION_ID REPOSITORY_ID ISSUE_NUMBER COMMENT_ID
```

The built equivalent is:

```sh
pnpm --filter @perry/control start --retry INSTALLATION_ID REPOSITORY_ID ISSUE_NUMBER COMMENT_ID
```

Replace the uppercase placeholders with the original numeric identifiers. The configured installation/repository IDs must match. This command needs `DATABASE_URL`, `PERRY_INSTALLATION_ID`, and `PERRY_REPOSITORY_ID`; it requeues only a matching failed request, preserves its stored result/slots, and exits. A running configured service then processes it. No match exits with failure. The command does not resolve ambiguous external state itself.

Oversized results become an explicit incomplete report. The pilot does not yet host overflow artifacts, and it must not claim its shortened publication contains every finding. Use the local command on the recorded commits to inspect a result outside the comment budget.

## Verification and remaining gates

Run the workspace checks and the local fixture entry point:

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm review:fixture
```

Set `PERRY_TEST_DATABASE_URL` through the test runtime to a dedicated disposable PostgreSQL database to include the store and signed-mention flow integration cases. Those cases are skipped when the variable is absent. Tests create isolated schemas and exercise real temporary Git history, persisted requests, duplicate delivery, independent answers, and publication recovery with simulated GitHub responses.

Live verification remains a separate maintainer task in #6: choose a private test repository and development installation, verify authorization, actual owned comments, a question reply, and redelivery/recovery. Record sanitized results. #5 separately verifies actual Anthropic review quality and billing-route acceptance on the synthetic fixture set. Neither issue closes solely because this pilot's automated tests pass.

Automatic source synchronization, CI readiness reconciliation, complete readiness rules, inline conversations, managed execution, hosted overflow reports, and full retention/deletion flows remain outside this pilot. Do not expose it as a general public multi-tenant review service.
