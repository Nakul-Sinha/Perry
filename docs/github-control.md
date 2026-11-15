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

PR questions inspect the PR head. The pilot skips PR requests when the PR is no longer open. Questions in an ordinary issue inspect its repository's default-branch commit. Without a configured model, the answer lists matching committed source excerpts; it is a bounded search, not a general explanation engine. The optional Anthropic route can answer using those excerpts and validated citations. An issue comment asking exactly `@Perry review` gets a clarification to select a PR.

Only `issue_comment` events with action `created` are processed. The mention must start the direct comment, allowing up to three leading spaces or initial blank lines. Quoted/fenced examples, inline review-thread comments, edits, bots, and empty requests do not trigger work. `@Perry review this PR` is a question rather than the exact review command. Effective repository write, maintain, or admin access is required; installation and comment ownership are checked again before publication.

## Operator prerequisites

- Git and Node.js 24, with dependencies installed using the repository's pinned pnpm version.
- A dedicated PostgreSQL database. Startup creates the pilot's `perry_deliveries`, `perry_mentions`, and `perry_slots` tables; the configured database role needs that access.
- A development GitHub App installed on the selected repository. The pilot needs Metadata read, Contents read, Pull requests read, and Issues write for its current source/comment flow.
- A maintainer-selected HTTPS webhook endpoint forwarding `/webhooks/github` to the local service. The service binds only to `127.0.0.1`; it does not provision a public endpoint or TLS termination.
- An operator-owned cache directory outside repositories being reviewed, with restricted filesystem access and an appropriate disk quota.

Subscribe the development App to issue comments. This pilot does not consume push, CI, approval, or installation-lifecycle events to update existing reports. The broader permission/event list in `plan.md` describes later readiness work, not additional current pilot behavior.

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
| `PERRY_PORT` | Optional localhost port, default `3000`. |
| `PERRY_ANTHROPIC_MODEL` | Optional account-available Anthropic model ID. Without it, the pilot uses static review and source-excerpt answers. |
| `ANTHROPIC_API_KEY` | Required by the optional Anthropic runner route; supply through an authorized local runtime configuration. |

The allowlist is one installation/repository pair per process. Other signed installation/repository events are not queued. Changing the allowlist does not migrate another installation's pending work or grant access to it.

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

Both workspace apps must remain together because control invokes the matching runner entry point. The worker runs in the same pilot service rather than a paired remote daemon. Closing the service stops new intake; PostgreSQL preserves accepted pending work for restart.

## Health and accepted work

- `GET /health/live` returns `200` when the HTTP process can respond.
- `GET /health/ready` returns `200` when its database query succeeds and `503` when unavailable. It does not validate the App, webhook endpoint, repository access, model, or billing account.
- `POST /webhooks/github` validates the raw-body signature and delivery identity. An accepted matching mention is persisted before acknowledgment. Invalid signatures are rejected; a persistence error remains retryable.

An accepted webhook response is not proof of requester authorization, a successful model call, or published comments. The worker rechecks current installation scope, repository identity, effective user permission, and the original comment's current intent. An edited/deleted request or revoked access can be skipped rather than assessed.

## Source and result behavior

The worker resolves full base/head IDs from an open PR or the default branch for issue questions. It fetches into a Perry-owned bare cache under the configured installation/repository scope and verifies the pinned objects. It uses repository-scoped read-only source access for acquisition and strips that access before starting the local runner.

The local runner inherits a limited environment, with model API access only when the optional model route is selected. It reads committed source rather than the developer's working tree. The webhook path does not enable `--test`, install dependencies, run repository scripts, or execute the Podman test profile. That profile remains a separate explicit local command.

PR reports include a numeric rating and either `HOLD` or `DO NOT MERGE`. The service does not evaluate live CI, approvals, mergeability, or branch rules and never recommends `MERGE`. Before completing review publication it re-reads the PR's base/head and can replace the current result with a stale-review hold if the commits changed during that run.

There is no automatic invalidation after later pushes or CI changes. Ask for a new review after a code change. Questions get their own reply tied to the triggering comment and do not replace the review pair.

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

Runner pairing, automatic source synchronization, post-publication push/CI invalidation, complete readiness rules, inline conversations, managed execution, hosted overflow reports, and full retention/deletion flows remain outside this pilot. Do not expose it as a general public multi-tenant review service.
