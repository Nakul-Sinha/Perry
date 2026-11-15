# Building Perry

Start with the [product specification](project%20idea.md), the [implementation plan](plan.md), and [repository rules](../AGENTS.md). Use this workflow to pick the next change and decide when another agent can depend on it.

## Working on a change

1. Fetch the current default branch, inspect the working tree and recent changes, and branch from the latest agreed base. Preserve edits already made by contributors.
2. Pick one row in the build order below. Record the milestone, product feature IDs, files you own, assumptions, dependency on another agent, and observable exit check in the working task. Keep tracking IDs out of commit subjects, commit bodies and PR descriptions. Read the corresponding plan sections before choosing libraries or interfaces.
3. Agree on the boundary before parallel work. Write down the inputs, outputs, trustworthy source of each field, how missing data is represented, and who will run the integration test. Give one agent ownership of each file. The integrator owns shared entry points, manifests, lockfile, CI and the final diff.
4. Build one behavior through its real entry point. Start with a small counterexample and a nearby example that should still work. Keep fixtures free of credentials and private source. Record whether a check inspected source, actually exercised behavior, or used a simulated external dependency.
5. Hand back the changed paths, command to exercise the feature, observed result, failure cases tested, and remaining gaps. Flag contract changes before editing a sibling's module. Ask a fresh reviewer to try to disprove findings using the adjacent clean case.
6. Integrate on the same base and run a frozen install, typecheck, tests and build. Run the user-facing command as well. Inspect the diff for changes outside the task. Validate a real external interaction separately when the exit check depends on one.
7. Update the status and next handoff where the behavior is documented. Use the commit and PR conventions in AGENTS.md. Keep a milestone open until someone can repeat its exit check from a clean checkout.

## Build order

| Step | Owner and dependency | Build | Evidence to hand to the next agent |
| --- | --- | --- | --- |
| 1. M0, F07-F09 | Contracts and fixtures, then integration | Define evidence, coverage, rating, and the two report bodies. Establish a clean fixture, a regression, and incomplete and failed states. Grow to the planned 20 starter fixtures. | A repeatable local command prints both bodies. A failed review still has a numeric score. Clean and broken fixtures have different, explainable outcomes. |
| 2. M1, F03/F06/F12 | Source and execution owners in parallel after agreeing on snapshot identity | Read pinned Git objects with bounded access. Separately implement the credential-free execution broker and disposable environment. | A dirty tree and branch switch cannot change source evidence. An isolated test run demonstrates resource limits, network policy, cleanup and separation from host credentials. |
| 3. M2, F02/F04-F09 | Investigation and backend owners after source and report contracts | Add one API route, bounded context including approved plans, an investigator, fresh verifier, and one targeted correctness check. Feed the verified result to the local report command. | Run a known cross-file regression and a closely matched clean change. Capture source spans, what the verifier rejected, check results and both comments. Exercise provider failure and budget exhaustion. |
| 4. M3, F01/F05/F07 | GitHub and storage owners once a local result can be replayed | Verify incoming events, authorize requester, persist jobs and publish two owned comment slots via an ordered outbox. | A private test PR produces one pair for an authorized mention. Redelivery, a head change during publication and restart after one write reconcile correctly. |
| 5. M4, F01/F03/F06/F11/F12 | Runner and storage owners after scoped jobs exist | Pair outbound runners, lease work, maintain an owned Git cache, reconcile refs, and provision clean per-run state. | Offline recovery, simultaneous PRs, a switch of local branch, a changed lockfile and base movement all have integration fixtures. Same-SHA CI updates readiness without another model call. |
| 6. M5, F04/F05 | Context owner using the pinned source interface | Retrieve callers, symbols, approved plans, tests and history. Account for every changed file and any missing material context. | A regression in an unchanged caller is linked to the changed cause. A PR changing its own review policy cannot suppress a finding. |
| 7. M6, F10 | Conversation owner after access and retrieval work | Answer PR and issue questions against authorized commits with citations and its own publication key. | Replaying a question yields one answer. The review score, generation and pair of review comments stay intact. |
| 8. M7, F02 | Connection owner after one real API route is proven | Add other eligible BYOK routes and supported native CLI routes individually. Validate entitlement, isolated startup, cancellation, model selection and billing mode. | Publish the tested provider/version matrix. Verify one real authorized call for each enabled route and a visible failure for unavailable routes. |
| 9. M8, F07-F09/F11/F12 | Reliability owner on the integrated system | Reconcile readiness with GitHub, fence stale results, bound costs, recover interrupted publication, and enforce access and retention on reports. | Exercise revoked access, stale positive reviews, changed required checks, duplicate writes, overflow and deletion. All accepted findings remain accounted for. |
| 10. M9, F04-F10 | Evaluation owner separate from prompt tuning | Freeze holdouts, compare the full-repo baseline, adjudicate errors, and test review procedures by domain and provider. | Report counts, precision, material recall and clean-PR false blocks against plan section 17. Keep each quality claim scoped to measured stacks. |
| 11. M10, F01-F12 | Release owner after quality and recovery evidence | Dogfood in shadow mode, then enable an opt-in beta with tested recovery, support, rollback and deletion procedures. | A maintainer can install, request a review, ask a question, recover an interrupted run, and disconnect using the published instructions. |

## First parallel assignment

Start with a local read-only baseline for Node package changes. It gives the later model and sandbox work a reproducible comparison and a visible failure path.

| Owner | Files in the runner | Handoff |
| --- | --- | --- |
| Source | `src/snapshot.ts` and its tests | Accept a selected local Git checkout and full base/head commit IDs. Resolve the merge base, enumerate changed paths and offer bounded reads of regular UTF-8 blobs at pinned revisions. |
| Investigation | `src/inspect.ts`, `src/module-syntax.ts`, `src/module-imports.ts` and their tests | Compare package manifests and direct script calls, parse changed ES modules, and check supported named imports against their providers. Report line evidence, fixes and coverage gaps. |
| Policy and reporting | `src/report.ts` and its tests | Apply the rubric to findings, incomplete coverage and independently supplied readiness facts. Render two safe Markdown bodies. Local mode has unknown GitHub prerequisites. |
| Integration | Runner contracts, CLI, fixture, workspace scripts, CI and docs | Wire all three pieces into one runnable command. Test real Git history, a clean control, missing commits, dirty files, and a changed file outside the supported checks. |

These modules initially live together in the runner so agents can exercise them through one executable. Split out packages when the control service first needs a shared contract.

### Handoff from the first implementation

Run `pnpm review:fixture` and `pnpm review:fixture clean` from the root. Both use real commits and the public local CLI. The broken case must identify the dangling npm script, invalid module syntax, and a missing export from an unchanged module at their pinned lines. The clean case changes the same files and must return zero findings. The `unsupported` and `missing` fixtures must produce provisional 0/10 reports. A failed snapshot acquisition also exits with status 1.

The implementation uses Node's built-in test runner for this deterministic suite and Acorn for static ES module declarations. The local command assumes a developer-selected Git store with trusted metadata. It reads regular committed source. The optional `--test` profile runs a single self-contained Node test for each pinned revision under rootless Podman. The separate Linux sandbox CI job exercises success, failure, deadlines, effective resource limits and container disposal.

Next assignments can start in parallel:

1. **Execution owner, M1.** Implement one credential-free, disposable Node check with a known success and failure, a timeout and a cleanup assertion. Record the exact platform and isolation settings before enabling it for incoming PRs.
2. **Model owner, M2.** Implement one owner-selected API backend and bounded read tools for approved plans, changed source and unchanged callers. Separate the candidate and verifier requests. Prove a cross-file finding and a refuted candidate through the local command, then verify the live route on an authorized fixture.
3. **Fixture owner, M0.** The 20 starter comparisons and four CLI scenarios are available via `pnpm review:fixture --list`. Run one with `pnpm review:fixture empty-cart` or run all with `pnpm test`. Expected outcomes live outside each temporary repository. The named-import check catches the unchanged consumer that still uses a removed export. The empty-cart plan mismatch remains a static miss. Both stay in the model evaluation.

The GitHub integration can be developed against the local source and report contracts while live model acceptance remains open. That does not close either live acceptance gate. Harness tests and static fixture results are evidence for the local preview only.

The Linux CI compatibility job now verifies the rootless single-test profile on the pinned image. The first Anthropic route has SDK transport, context selection, investigation and independent verification tests. For live acceptance run `pnpm check:model MODEL_ID` with authorized API access. It exercises `empty-cart`, `unchanged-consumer` and `cart-refactor`, checks each report, and exits on the first failure. Inspect both comments for the real trigger, prior behavior, head citation and suggested fix. Record the model ID, outcomes, missed or refuted claims and actual billing route before closing the model milestone.

### Handoff from the GitHub control pilot

Read [GitHub control](github-control.md) before starting the service. The current pilot is configured for one installation and repository. It accepts signed, newly created, directly addressed general PR or issue comments, checks effective requester access, persists requests in PostgreSQL, and invokes the local runner against pinned Git history. PR reviews update two owned comment slots. Questions use a separate answer slot for each triggering comment and leave the review pair intact.

`pnpm dev:control` runs the source service. After `pnpm build`, `pnpm --filter @perry/control start` runs the built entry point. Configuration and the explicit `--retry` operator command are documented in the pilot guide. Failed publication can quarantine a thread so a newer request cannot overtake an uncertain old write. Reconcile the recorded App-owned comments before retrying.

The automated flow test uses real temporary Git history and, when `PERRY_TEST_DATABASE_URL` is supplied, real PostgreSQL. GitHub responses and comment publication are simulated in tests. A test run without that database setting skips the database integration cases. Neither mocked transport nor database tests verify a live GitHub installation.

Keep the acceptance work separate:

- [#5: live Anthropic reviews](https://github.com/Nakul-Sinha/Perry/issues/5) requires an authorized selected model and recorded live fixture results.
- [#6: private GitHub installation](https://github.com/Nakul-Sinha/Perry/issues/6) requires a maintainer-owned development App, selected private repository, signed delivery, actual owned comments, a question reply, and redelivery/recovery evidence.

The pilot does not implement inline review threads, runner pairing, live CI/approval/branch-rule readiness, push-triggered invalidation, or automatic re-reviews. It runs source checks with an optional Anthropic investigation, not the local `--test` execution profile. Its reports remain `HOLD` or `DO NOT MERGE`; a new direct review comment is needed after source changes. Do not describe the broader M3/M4/M8 exit checks as complete until their specified live and lifecycle evidence exists.
