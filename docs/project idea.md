# Project idea: Perry

**Version:** V1 product specification

**Prepared:** 14 November 2026

**Status:** Proposed product. Perry has not yet been implemented or benchmarked.

This document defines what Perry should do, who it serves, the complete user experience, and the conditions under which its output is useful. The companion [plan.md](plan.md) defines the technology, scaffolding, implementation, and validation work.

## 1. The idea

Perry is a repository-aware code reviewer that developers can call from a GitHub pull request. A developer installs Perry on a repository, connects a model or a supported coding CLI, and comments `@Perry review`. Perry examines the PR in the context of the repository and its planning documents, investigates mistakes, runs relevant code in an isolated environment, and posts its review directly in that PR.

Each review has two concise comments. The first explains the actual technical changes, gives a mandatory rating out of 10, and says whether to merge, hold, or fix the PR first. The second lists verified bugs and short suggested fixes. Developers can also mention Perry to ask questions about the PR or the repository.

Perry maintains a local repository cache and reusable environment preparation so it can stay current without repeatedly starting from nothing. Every review runs against the PR's exact commits in a clean execution environment. The developer continues working in their own clone while Perry investigates separately.

The intended experience is a dependable review companion for developers using strong coding agents, including the Sonnet, Opus, Astra, Sol, DeepSeek, and GLM families when available through their chosen connection. These names describe evaluation and compatibility interests; they are not guarantees about model availability, relative capability, or account access.

## 2. The problem Perry solves

Coding agents can produce changes faster than a developer can inspect every interaction with the rest of a codebase. A change may look reasonable in isolation while breaking an unchanged caller, missing a planning requirement, weakening authorization, or causing a failure that appears only when the application runs.

Developers need review that understands the surrounding system, challenges plausible implementations, and returns useful evidence. They also need the review inside their existing PR conversation, with clear decisions and little noise.

Perry should reduce the time required to identify consequential defects and understand whether a change is ready. It should help developers address a specific failure rather than generate a long list of subjective improvements.

## 3. Goals and limits

Perry's primary goals are to:

- Find real correctness, security, compatibility, and reliability problems introduced or newly exposed by a PR.
- Consider relevant code throughout the authorized repository, rather than stopping at the diff.
- Compare implementation with approved plans, acceptance criteria, contracts, and architectural decisions.
- Exercise relevant behavior in a sandbox and attach evidence to findings where possible.
- Provide a concise technical summary, an always-present numerical rating, and a clear merge recommendation.
- Suggest actionable fixes and answer follow-up questions with source references.
- Offer both bring-your-own API access and eligible connections to a user's installed coding CLI.
- Preserve the developer's working tree and keep review results reproducible.

Perry cannot promise that arbitrary software contains no mistakes. A green test run, agreement between models, and a `10/10` rating do not establish perfect correctness. The quality promise must be measured on declared supported stacks and accompanied by honest coverage and limitations.

V1 is a review and explanation product. It does not write fixes into the repository, push commits, approve a PR automatically, merge it, or deploy it.

## 4. Who V1 is for

The initial audience is an individual developer or a small development team already using GitHub PRs and coding agents. The repository owner or administrator installs the App and authorizes repository access. Developers with sufficient existing GitHub access can request reviews and answers. Perry does not introduce a separate collaboration or organization-role system in V1.

The first quality-supported profile should be narrow and explicit, such as TypeScript/React with a Node backend. Perry may read other languages and recognize infrastructure or ML changes, but it must label limited support until those domains have been evaluated. Support is a tested capability, not merely the ability to send a file to an LLM.

## 5. V1 scope

| ID | Capability | Required behavior |
|---|---|---|
| F01 | Onboarding | Install the GitHub App on explicitly selected repositories, pair a local runner, and establish repository expectations. |
| F02 | Model connections | Bring an eligible Anthropic, OpenAI, or OpenCode API connection, or connect a supported installed coding CLI. |
| F03 | Local preparation | Maintain authorized source/index caches and reusable clean environment preparation. |
| F04 | Repository context | Search and read eligible code, configuration, tests, schemas, planning documents, and relevant history at exact commits. |
| F05 | Review investigation | Authorized `@Perry review` request starts investigation of candidate defects, independent verification, and suggested repairs. |
| F06 | Runtime evidence | Exercise relevant behavior in a clean sandbox, compare appropriate base/head behavior, and retain supported evidence. |
| F07 | Required review output | Two managed PR comments: summary/rating/recommendation; bugs/suggested fixes. Label whether repairs were tested. |
| F08 | Rating | Integer 0–10 merge-readiness score on every review response, including explicit provisional states. |
| F09 | Merge readiness | Distinguish Perry's recommendation, GitHub prerequisites, check results, and unknown information. |
| F10 | Questions | Respond to addressed questions in PR conversations and repository issue threads with source references. |
| F11 | Synchronization/freshness | Refresh relevant cached state on events and periodic reconciliation; bind results to exact commits and invalidate outdated recommendations. |
| F12 | Recovery/privacy | Enforce access and usage limits, recover interrupted work/publication, show honest failures, and honor retention/deletion policy. |

GitLab/Bitbucket, cross-repository analysis, automatic reviews after every push, slash commands, collaboration dashboards, autonomous fixes/merges, scheduled audits, and model fine-tuning are outside V1.

## 6. Complete user flow

### 6.1 Install and select repositories

The owner opens Perry setup, installs the GitHub App, and selects repositories. Setup explains the read access needed for code and PR information and the write access needed to post PR comments. Perry must not request repository code-write authority for this workflow.

The owner sees the actual installed bot identity. The product is called Perry, but the exact GitHub App name or username may be unavailable. Perry can parse `@Perry` as text in comment events even if GitHub does not autocomplete or link that alias. The user's `@Peryy` spelling can be accepted as a configured text alias; it is not a second GitHub identity.

Repository installation alone does not start paid reviews or execute repository code.

### 6.2 Connect a local runner

The owner installs and pairs Perry's local runner, then links it to the selected repositories. The runner normally lives on the developer's machine or a private machine they control. It makes an outbound connection to receive authorized work; the developer does not need to expose their laptop through a public inbound port.

Setup lets the owner explicitly select an existing local clone to accelerate preparation. Perry keeps its own cache and does not depend on that clone remaining on one branch or retaining every Git object. The owner can also let Perry acquire source through its authorized repository access.

Perry shows whether the runner is online, the connected repositories, and whether the environment is ready. If the runner is offline, new requests wait for a bounded period and then show an honest pending or failed status. Reviews do not secretly move to a different machine or billing mode.

### 6.3 Choose the model connection

The owner chooses one of two modes:

**Bring your own API access.** The owner selects an eligible provider, configures access through the supported secure setup, chooses an available model, and sets usage limits. Perry explains which provider receives repository content. Setup verifies the connection and necessary capabilities before enabling it.

**Connect a coding CLI.** Perry detects a supported installed CLI and uses its documented native interface. The user authenticates through the provider's own flow. Perry shows whether that account, product deployment, and repository scope are eligible. The user's machine must remain available while the job runs.

These modes are not interchangeable billing arrangements. A subscription is not automatically a reusable API key, and Perry must not extract cached account tokens or pool multiple users' allowances. An unavailable connection shows its reason and a supported alternative; it must not appear successfully connected.

### 6.4 Establish repository expectations

The owner can identify planning/documentation paths, the initial supported stack, relevant test commands or environment definition, and review limits. Perry also discovers conventional repository documents and existing project guidance.

Configuration must be small enough for V1. A developer should not have to design an agent workflow merely to receive a review. Perry should identify missing requirements and say which checks cannot run, rather than pretend setup is complete.

Reviewer policy is read from the approved base/default branch. A PR may propose changes to that policy, but cannot weaken the rules governing its own review.

### 6.5 Develop normally while Perry stays prepared

The developer edits, commits, and pushes using their usual tools. Perry updates authorized cache/index state in the background and prepares reusable environment layers when appropriate. It leaves uncommitted work and the active branch untouched.

A local commit is a hint for preparation, not proof that it is the remote PR's current head. A push or base-branch update refreshes relevant source state and invalidates an old review. A CI event at the same commit normally updates readiness information rather than downloading or testing identical source again. Periodic reconciliation catches missed events while the runner is online.

Background preparation does not start full paid reviews in V1. The explicit mention remains the trigger for investigation and runtime review.

### 6.6 Request a review

In the PR conversation, an authorized developer comments:

```text
@Perry review
```

By default, users with effective repository write, maintain, or admin access can incur model usage. Public visitors and fork authors without those permissions cannot trigger work simply by mentioning the bot. A maintainer can request review of a fork PR.

Perry ignores its own comments, other bots, unrelated text, quoted mentions, and mentions inside code fences. Editing an existing trigger does not create another review in V1. A review command outside a PR receives a short explanation because no PR has been selected. A maintainer-requested fork review can still have limited runtime coverage while public-fork execution is gated; that limitation must be visible.

Perry creates or updates its two managed review comments. While running, the summary shows a provisional `0/10` readiness score and `HOLD - assessment in progress`. This value describes an unfinished readiness assessment; it does not accuse the code of being broken.

### 6.7 Review the exact PR

Perry resolves the current PR commits and freezes the review inputs. It reads changed code and relevant unchanged code, interprets approved intent, and investigates possible failures. It prepares a clean environment and runs affected checks or targeted scenarios when feasible.

Perry challenges each proposed finding before posting it. It considers caller constraints, existing guards, intentional behavior changes, dependency versions, base behavior, and contrary test evidence. Unsupported suspicions are rejected or recorded as limitations. A material unresolved risk produces `HOLD`, not a confirmed bug invented to justify caution.

The final review identifies the reviewed commit and coverage. Both comments come from the same reconciled result. GitHub cannot publish two comments atomically; Perry writes them back-to-back and recovers interrupted publication without adding duplicate review pairs.

### 6.8 Read the result and fix the PR

The developer reads the concise first comment, then investigates the bug list and evidence in the second. They apply changes themselves or ask their coding agent to implement a suggested repair.

Perry does not silently modify source. Suggested fixes are advice; a fix not exercised by Perry must remain labeled as suggested. Developers retain responsibility for inspecting changes and completing normal GitHub requirements.

After the fix is pushed, Perry invalidates the previous recommendation. The developer comments `@Perry review` again. Perry reviews the new snapshot and updates the existing two review slots. It reevaluates previously reported problems against the new code rather than assuming they remain present or were fixed.

### 6.9 Ask questions

Examples include:

```text
@Perry why is this retry unsafe?
@Perry where else is createOrder called?
@Perry does this implementation satisfy the retry requirement in the plan?
@Perry what happens when this service returns an empty response?
```

Perry answers in a separate concise comment with commit-specific source references. A question in a PR can use that PR and its repository; a question in an issue uses the authorized repository's pinned default-branch snapshot. The answer identifies uncertainty or asks a short clarification if the requested reference is ambiguous.

Q&A does not replace the two review slots, change their score, start a merge, or grant access to another private repository. Ordinary questions do not require a `/10` rating. Inline diff-thread interactions can be added after V1; the supported entry point is the top-level conversation.

### 6.10 Disconnect or remove access

The owner can stop the runner, disconnect a repository or model connection, or uninstall the App. Perry stops new work for revoked access and cancels or safely terminates active work. Publication requires current access, not merely permission that existed when the job began.

Setup and documentation must state what cached source, artifacts, and run history remain and how deletion works. Removing access must not leave a hidden route for future repository reads or paid usage.

## 7. The two-comment contract

### Comment one: summary, rating, and merge recommendation

The first comment contains a short technical account of actual changes, the mandatory score, the merge recommendation, and compact coverage/check information. Prefer 3–6 concrete technical bullets and normally fewer than 120 words overall.

Illustrative example:

```text
Perry review · abc1234

Summary
- Converted createOrder to async and awaited inventory reservation.
- Added an orders.idempotency_key unique index.
- Updated package-x from 2.3.1 to 2.4.0.

Rating: 5/10 merge readiness
Merge recommendation: DO NOT MERGE - 1 high-severity bug.
Checks: CI passed; 12/12 eligible changed files examined.
```

Avoid generic praise, an exhaustive filename list, and unsupported claims about why the author made a change. A summary must not state an intended feature as completed when the implementation does not establish it.

### Comment two: bugs and suggested fixes

Every finding includes severity, exact source location, trigger, consequence, concise repair advice, and evidence. Group symptoms caused by the same root cause. Include every supported in-scope finding; do not fill a quota or hide valid bugs to keep the comment attractive.

Illustrative example:

```text
Bugs and suggested fixes · abc1234

1. [High] Retry can reserve inventory twice - src/orders.ts:84
   Trigger: the client retries after reservation succeeds but before the order is saved.
   Impact: inventory is reduced twice for one order.
   Fix: claim the idempotency key before reservation and reuse the stored result on retry.
   Evidence: the regression test fails on this commit and passes on the base commit.
```

Code locations link to the reviewed commit, not a moving branch. Logs and runtime artifacts should be accessible without exposing sensitive data.

If nothing is verified, say `No verified bugs found within the reviewed scope` and mention meaningful limitations. If the review failed, identify the missing prerequisite instead of presenting an empty bug list as a clean result.

Perry maintains two current review slots per PR across reruns. Q&A replies are additional comments because they are separate conversations. If all findings cannot fit, compact them and link an authorized full report with explicit totals and overflow counts. If that report cannot be made available safely, mark the result incomplete rather than silently truncating it.

## 8. Meaning of the score and merge status

The always-required score is an integer from 0 to 10 measuring **merge readiness under this assessment**. It is not a probability that the code is correct, an author-quality score, or a certification. The exact deterministic rubric is versioned in the implementation plan.

| Situation | Rating treatment |
|---|---|
| Complete assessment with no known blockers and satisfied prerequisites | May receive 10/10. |
| Accepted bugs | Reduce the score, with severity-based caps. |
| Pending or unknown required checks/prerequisites | Cap readiness and prevent a merge recommendation. |
| Partial coverage or material unresolved risk | Provisional/capped readiness and explicit limitations. |
| Queued, failed, canceled, stale, or wholly unassessed | 0/10, explicitly provisional with the reason. |

The merge recommendation is computed separately:

| Status | Meaning |
|---|---|
| **MERGE** | Fresh completed review, adequate coverage, no accepted material bug or unresolved material risk, and applicable GitHub prerequisites satisfied. |
| **DO NOT MERGE** | A verified material bug, failing required check, or known conflict requires action. |
| **HOLD** | Assessment, freshness, required information, or readiness is incomplete or uncertain. |

If there is both a known bug and incomplete coverage, show `DO NOT MERGE` and the limitation. A high score cannot override a blocker. Perry's recommendation, GitHub conflict state, CI results, and human approval requirements remain distinct facts. Perry does not submit an automatic approving review or bypass branch rules.

## 9. Whole-repository context and planning documents

Whole-repository context means Perry can retrieve relevant eligible material throughout the authorized repository. It does not mean every byte fits into one model call, every file receives the same depth of analysis, or dynamic dependencies can always be resolved.

Perry should consult entry points, related functions and callers, type/data contracts, API schemas, tests, migrations, manifests, lockfiles, configuration, relevant history, plans, ADRs, and acceptance criteria. An unchanged file can be essential evidence for a bug introduced by the PR.

Approved project policy governs the review. PR-authored plans or instruction files may explain intended work, but cannot tell Perry to suppress a bug, export code, change access, or skip safety requirements. If approved intent and implementation conflict, Perry should expose the conflict rather than choose silently.

Every changed file receives a coverage disposition. Generated files, binaries, submodules, unsupported languages, and unavailable large-file content must be accounted for. Material missing context prevents a claim of complete assessment. Access to one repository does not authorize adjacent private repositories, services, or dependencies.

## 10. The maintained sandbox experience

Perry should stay prepared while keeping each execution reproducible:

1. Maintain an owned local cache of authorized source and commit-keyed indexes.
2. Reuse clean, verified dependency downloads and environment preparation when their inputs match.
3. Freeze the PR's exact source when a review starts.
4. Create fresh execution state for that review, including isolated fixtures and services.
5. Exercise affected behavior and collect evidence.
6. Discard writable execution state while retaining permitted review artifacts.

A single long-lived application instance must not accumulate state from multiple PRs. Later commits update preparation for future runs rather than modifying the source under a running review. Developer branch switches and dirty files must not leak into the official PR assessment.

Useful checks include existing tests, targeted regression tests, API scenarios, frontend interactions, error handling, retries, races, and migration exercises. Both compared commits must use appropriate dependencies and environment definitions. Setup failures, flaky tests, and failures present on both versions do not automatically prove a PR regression.

Runtime evidence strengthens findings for the paths exercised. Source analysis remains necessary to select those paths and identify failures that current tests never cover.

## 11. Provider and account caveats

API access is the dependable baseline for unattended reviews. OpenCode's API service and its installed coding agent are distinct connection options, with different capabilities and billing arrangements. Eligibility must be checked for the actual model, endpoint, and account.

Native coding-CLI integration must keep user authentication inside the provider's supported flow. Perry must not copy account caches into a hosted service, sell pooled subscription usage, or silently switch from subscription usage to paid API calls.

Claude Code's published guidance distinguishes an unmodified native binary with end-user authentication from custom applications routing subscription credentials. The supported native integration must also pass configuration and execution-isolation checks. [Anthropic guidance](https://code.claude.com/docs/en/legal-and-compliance)

OpenAI documents different boundaries for local/open-source app-server authentication and commercial/hosted products. Official ChatGPT-plan integration requires the applicable registered flow and consent; eligibility must be established before the route is advertised. [App-server guidance](https://learn.chatgpt.com/docs/app-server), [ChatGPT-plan integration](https://developers.openai.com/siwc/token-sharing-open-source)

Perry displays `supported`, `needs setup`, or `unavailable` with a precise reason. The presence of a CLI on disk is not proof that every subscription-backed product use is permitted or safe. Provider terms and interfaces must be rechecked before release.

## 12. Privacy and trust

Setup must explain which code reaches the selected model provider, which artifacts are retained, and where reviews execute. A local runner does not imply local model inference: a CLI may still send code to its provider.

Repository execution must not inherit the developer's personal account access, GitHub publishing authority, home-directory files, or unrelated project data. Model-controlled tools receive only approved repository access. Tests run separately from authenticated model/CLI processes.

PR content, repository instructions, dependency scripts, and logs can contain hostile instructions. They are review data, not authority to change Perry's permissions or publishing behavior. Public-fork execution remains disabled until the selected isolation design passes its release tests.

Minimize stored source and transcripts, secure report access, redact sensitive material in published evidence, and provide a stated retention/deletion policy. Do not promise zero provider retention or complete data isolation without the necessary verified capabilities.

## 13. Failure and edge-case behavior

| Situation | Required user-visible behavior |
|---|---|
| Runner offline | Show pending status for a bounded period, then a clear provisional failure/HOLD if it cannot proceed. |
| Model login expired or provider unavailable | Explain the connection problem; no clean fallback or surprise billing change. |
| Usage/time limit reached | Stop within limits, report incomplete assessment, and show provisional readiness. |
| New PR commit or base advance during review | Mark the run stale; never present its recommendation as covering new source. |
| CI rerun, approval, or rule change at the same source | Refresh readiness and invalidate an outdated positive recommendation without unnecessary inference. |
| Unknown mergeability or required prerequisites | HOLD until verified; unknown does not mean passed. |
| Missing source or unsupported material change | Explicit coverage limitation; no blanket completed-review claim. |
| Dependencies or test services cannot start | Report environment limitation; do not invent a product defect. |
| Contradictory/flaky runtime evidence | Reinvestigate, qualify uncertainty, or reject the candidate. |
| Duplicate webhook or interrupted comment write | Reconcile the existing request/comments rather than duplicate reviews. |
| Oversized bug list | Preserve access to all supported findings with explicit overflow accounting. |
| Unauthorized mention | No paid job or privileged execution. |
| Revoked repository access | Stop work and publication; follow deletion policy. |

## 14. Quality standard and success criteria

Perry must demonstrate value against a strong frontier coding agent given repository tools and review instructions, rather than only outperform a weak diff prompt. Relevant measures include finding precision, material-bug recall, severe-bug recall, incorrect blockers on clean PRs, summary accuracy, repair validity, cost, latency, and coverage honesty.

Proposed beta targets are 90% finding precision, 70% material-bug recall, and 80% high/critical recall, with at most 10% of clean PRs receiving an incorrect blocking finding. These are proposed release gates, not current measurements. Results need adequate labeled samples, confidence intervals, and breakdowns by supported stack and connection.

The evaluation set should include real regressions, clean changes, cross-file bugs, and changes authored by multiple coding-agent families. Future fixes and hidden ground-truth tests must not leak into reviewer input. Safety, freshness, permissions, and interrupted-publication cases must also pass before public operation.

Trusted review/audit skills and FE/BE/DevOps/ML guidance can inform versioned procedures. Using those procedures is runtime guidance, not training model weights. V1 should curate only applicable checks, preserve source provenance and license obligations, and evaluate whether they improve results. It should not claim that importing famous skills makes review industry grade.

The first release is successful when developers can complete the stated flow, receive useful supported findings with little noise, see honest limitations, and rely on Perry's access and publication behavior. Broad support should expand only after equivalent evidence exists.

## 15. Explicitly deferred features

- GitLab, Bitbucket, and other hosting platforms.
- Cross-repository and production-service context.
- Automatic full reviews after every commit or push.
- Slash-command systems, collaboration dashboards, and custom team workflows.
- Automatic fix commits, fix PRs, approvals, merges, and deployments.
- Standalone uncommitted-code review and repository-wide scheduled audits.
- Continuous model training, automatic unreviewed preference learning, and an unrestricted skill marketplace.
- Universal native-OS parity and managed multi-tenant execution before those environments pass their own validation.

These may be later releases. V1 should remain focused on repository-aware, execution-supported PR review and questions from the PR conversation.

## 16. Product acceptance checklist

- A repository owner can connect selected repositories, a runner, and an eligible model backend without changing ordinary development habits.
- `@Perry review` produces two reconciled PR review comments with a concise technical summary, numeric rating, merge recommendation, and supported bugs/fixes.
- Whole-repository context includes relevant planning files and unchanged consumers, with exact source references and visible coverage limits.
- Automatic preparation stays separate from on-demand review; sandbox execution uses frozen source and clean per-review state.
- Follow-up questions receive grounded answers without changing review authority or accessing another repository.
- Reruns, new commits, CI changes, failures, usage limits, and revoked access produce the defined behavior.
- API and CLI connection modes work only within their validated capabilities and provider eligibility.
- Quality and operational release gates are demonstrated before Perry is described as ready for the declared production scope.
