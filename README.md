# Perry

Hiii, This is Perry, A code review and audit tool i'm building

Perry reviews ur PRs using the surrounding repository elements, planning files, tests, and relevant history. Mention `@Perry review` in a PR to get a concise review, a rating out of 10, a merge recommendation, and bugs with suggested fixes. You will also be able to ask questions in the PR conversation. Let Perry be senior Software Dev that finds your mistakes and guides u through them :) 


## Features

### V1: being built

- On-demand GitHub PR reviews and repository questions through mentions.
- Context from relevant code, unchanged callers, plans, schemas, tests, and history.
- A maintained local repository cache with a clean, commit-pinned sandbox for each review.
- Targeted checks and reproductions, followed by a separate verification pass for suspected bugs.
- Two PR comments: summary, numeric rating, and merge status; then bugs and suggested fixes.
- API access through Anthropic, OpenAI, or an eligible OpenCode connection.
- Eligible local Claude Code or Codex CLI connections using the user's own supported login.
- Clear coverage limits, usage limits, and stale-review handling.

The rating measures merge readiness. A 10/10 is not a promise of bug-free code, and Perry will not automatically modify or merge your PR it will suggest you and  you will decide what to do.

### V2: possible additions

- Inline review conversations and optional automatic re-reviews.
- Suggested fix patches and configurable review checks.
- GitLab and Bitbucket integrations.

### V3: possible additions

- Cross-repository context and team collaboration.
- Managed execution environments and scheduled audits.
- Optional fix PRs with human approval.


## Local setup

The first working feature is a local review preview. It reads committed source, compares it with the merge base, and prints the summary and bugs comments to your terminal. Install [Git](https://git-scm.com/downloads) (tested with 2.49) and [Node.js 24 LTS](https://nodejs.org/en/download), then run:

```sh
npm install --global pnpm@12.18.0
git clone https://github.com/Nakul-Sinha/Perry.git
cd Perry
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm review:fixture
```

The fixture removes a script that another script still calls, introduces a syntax error, and imports a name that an unchanged module never exported. Try `pnpm review:fixture clean` for the matching control. Both commands use temporary Git commits and work without an account or API key.

To review a real change, run this from Perry's checkout. Replace the path and both IDs with your values. Get the IDs with `git rev-parse <branch>` inside the repository you want to review.

```sh
pnpm review:local --repo "/path/to/your/repo" --base FULL_BASE_SHA --head FULL_HEAD_SHA
```

Use a trusted local repository root with complete history. The preview reads up to 256 changed paths. Its checks cover package manifest JSON, direct npm script calls, Node 24 syntax for `.mjs`, and selected named imports between local `.mjs` files. It ignores working-tree edits and lists gaps in coverage. Without live GitHub prerequisites, a local review can flag a blocker or recommend holding a PR.

The [agent workflow](docs/agent-workflow.md) tracks implementation order, test evidence, and the next handoff.

### GitHub control pilot

The single-repository control pilot accepts direct `@Perry review` comments in an open PR and direct questions in a PR or issue. It verifies signed deliveries and requester access, keeps work in PostgreSQL, fetches pinned source into an owned cache, and publishes two review comments or a separate answer. Without a model, questions return matching committed source excerpts.

Configure the pilot as described in [GitHub control](docs/github-control.md), then start it from this checkout:

```sh
pnpm dev:control
```

Only newly created general conversation comments are supported. Perry periodically checks the base and head of reviewed PRs. A changed commit or closed PR marks the existing pair stale. Request a new review to assess new code. CI-only changes and inline review threads are still pending. The pilot reports `HOLD` or `DO NOT MERGE`. Operators can enable a rootless Podman check for reviews. Automated tests use simulated GitHub responses; live private-installation acceptance remains open in [#6](https://github.com/Nakul-Sinha/Perry/issues/6). Live Anthropic acceptance is tracked separately in [#5](https://github.com/Nakul-Sinha/Perry/issues/5).

### Run an isolated Node test

On Linux with rootless Podman and cgroup v2, prepare the pinned Node image once. Select a self-contained committed ES module test from a repository you control. Perry runs its merge-base and head versions separately and prints both outcomes.

```sh
podman pull docker.io/library/node@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5
pnpm review:local --repo "/path/to/your/repo" --base FULL_BASE_SHA --head FULL_HEAD_SHA --test tests/total.test.mjs
```

To exercise an application module, add `--module src/total.mjs` if the test imports that file. Perry copies the committed test and selected module into a fresh container for each revision, preserving their relative paths. The profile supports Node built-ins and this single dependency. The report records missing files or runtime support. A failure describes the selected test in this isolated profile.

For PR mentions, configure `PERRY_TEST_PATH` and optionally `PERRY_TEST_MODULE` on the control host. See the [operator guide](docs/github-control.md).

### CLI login mode

API keys are not always easy to keep at your disposal, so Perry is being built with a way to connect an eligible Claude Code or Codex CLI login on your own device.

Install your chosen CLI using its official instructions, then authenticate directly with that provider:

```sh
# Claude Code
claude auth login
```

```sh
# Codex
codex login
```

These commands sign in to the provider, not Perry. Connecting that session to Perry is still being built. Subscription eligibility depends on the provider and deployment; Perry will not copy account tokens or pool allowances.

### Bring your own key

The local runner has an opt-in Anthropic Messages API adapter. Supply `ANTHROPIC_API_KEY` to the Perry process through your local secret store. Pick a model ID available to your Anthropic account. Provider usage is billed to that account. These examples run against synthetic Git history:

```sh
pnpm review:fixture empty-cart --anthropic-model MODEL_ID
pnpm review:fixture cart-refactor --anthropic-model MODEL_ID
```

For your own checkout, add the same flag to `pnpm review:local`. The option sends selected committed source, approved base plans and related callers to Anthropic. Static-only reviews stay local. Perry checks model citations against both revisions and sends candidate findings to a fresh verifier. Reports identify unavailable or incomplete model responses. The adapter has automated transport and verification tests. Live account acceptance is pending. OpenAI and OpenCode adapters and native CLI connections are planned.

Until the connection flow ships, you can give your coding agent this prompt:

```text
Read AGENTS.md, docs/project idea.md, and docs/plan.md.
Check which setup and model connection features actually exist.
Help me configure a supported CLI login or BYOK connection if available.
Keep credentials out of tracked files and test processes.
If the connection is not implemented, explain what is missing and stop.
Do not invent commands or start implementing features without asking.
```

The workspace starts with `apps/control` for GitHub integration and `apps/runner` for local execution. Shared configuration lives in `config/`, and the project documents live in `docs/`.

## References and inspiration

- [CodeRabbit](https://www.coderabbit.ai/) and [Greptile](https://www.greptile.com/) for the review workflow.
- [Google review practices](https://google.github.io/eng-practices/review/reviewer/) and [Trail of Bits skills](https://github.com/trailofbits/skills) for review and audit procedures.
- [Claude Code authentication](https://code.claude.com/docs/en/authentication) and [Codex authentication](https://learn.chatgpt.com/docs/auth?surface=cli) for supported login flows.

## Open to suggestions

If you have ideas, useful review examples, or a workflow Perry should handle, open an issue. Suggestions are welcome.
