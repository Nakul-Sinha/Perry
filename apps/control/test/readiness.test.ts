import assert from "node:assert/strict";
import test from "node:test";
import { Octokit } from "@octokit/rest";
import { collectReadiness } from "../src/readiness.ts";
import type { MentionRequest } from "../src/intake.ts";

const request: MentionRequest = {
  installationId: "5", repoId: "17", owner: "Example", repo: "Tool", number: 3,
  sender: "maintainer", senderId: "7", commentId: "11", kind: "review", text: "review", isPR: true,
};
const base = "a".repeat(40), head = "b".repeat(40), merge = "c".repeat(40);
const pull = {
  id: "PR_3", number: 3, state: "OPEN", baseRefName: "main", baseRefOid: base, headRefOid: head,
  isDraft: false, isMergeQueueEnabled: false, reviewDecision: "APPROVED", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
  potentialMergeCommit: {oid: merge, parents: {nodes: [{oid: base}, {oid: head}]}},
};
const run = {
  id: "run", __typename: "CheckRun", isRequired: true, name: "build", status: "COMPLETED", conclusion: "SUCCESS",
  checkSuite: {app: {databaseId: 17}},
};
const legacy = {id: "status", __typename: "StatusContext", isRequired: true, context: "build", state: "ERROR"};
const rule = {type: "required_status_checks", parameters: {required_status_checks: [{context: "build", integration_id: 17}]}};
function rollup(nodes: object[], totalCount = nodes.length, next: string | null = null) {
  return {contexts: {totalCount, nodes, pageInfo: {hasNextPage: next !== null, endCursor: next}}};
}
interface Fixture {
  pull?: (call: number) => object;
  rules?: (page: number) => Response;
  checks?: (sha: string, after: string | null, call: number) => ReturnType<typeof rollup> | null;
  restCount?: number;
}
async function observe(fixture: Fixture = {}) {
  let pulls = 0;
  const shaReads: string[] = [];
  const errors: unknown[] = [];
  const api = new Octokit({log: {debug() {}, info() {}, warn() {}, error() {}}, request: {
    fetch: async (input: string, init: RequestInit) => {
      // Propagate fixture assertion failures outside Octokit's request error wrapper.
      try {
        const url = new URL(input);
        assert.equal(url.origin, "https://api.github.com");
        if (url.pathname === "/graphql") {
          const {query, variables} = JSON.parse(String(init.body));
          assert.equal(variables.owner, request.owner);
          assert.equal(variables.repo, request.repo);
          let fields;
          if (query.includes("query PerryPull(")) {
            assert.equal(variables.number, 3);
            fields = {pullRequest: fixture.pull?.(++pulls) ?? pull};
          } else {
            assert.ok(query.includes("query PerryChecks("));
            assert.equal(query.match(/isRequired\(pullRequestId:\$pr\)/g)?.length, 2);
            assert.equal(variables.pr, pull.id);
            shaReads.push(variables.sha);
            const statusCheckRollup = fixture.checks ? fixture.checks(variables.sha, variables.after, shaReads.length) : rollup([run]);
            fields = {object: {oid: variables.sha, statusCheckRollup}};
          }
          return Response.json({data: {repository: {databaseId: 17, ...fields}}});
        }
        assert.ok(url.pathname.startsWith("/repos/Example/Tool/"));
        if (url.pathname.endsWith("/rules/branches/main")) {
          assert.equal(url.searchParams.get("per_page"), "100");
          return fixture.rules?.(Number(url.searchParams.get("page"))) ?? Response.json([rule]);
        }
        assert.ok(shaReads.includes(url.pathname.split("/")[5]!));
        if (url.pathname.endsWith("/check-runs")) return Response.json({total_count: fixture.restCount ?? 0, check_runs: []});
        if (url.pathname.endsWith("/statuses")) return Response.json([]);
        throw new Error("Unexpected route " + url.pathname);
      } catch (error) {
        errors.push(error);
        throw error;
      }
    },
  }});
  const result = await collectReadiness(api, request, {base, head}, new AbortController().signal);
  assert.deepEqual(errors, []);
  return {result, shaReads};
}

test("test merge takes precedence and same-name required check and status must both pass", async () => {
  const {result, shaReads} = await observe({checks: () => rollup([run, legacy])});
  assert.deepEqual(shaReads, [merge]);
  assert.equal(result.checks, "failed");
  assert.equal(result.checkSha, merge);
  assert.equal(result.freshness, "current");
  assert.equal(result.mergeability, "clean");
  assert.equal(result.prerequisites, "unknown");
});

test("visible successful checks cannot prove the full policy or inherit an optional failure", async () => {
  const nodes = [{...run, conclusion: "NEUTRAL"}, {...run, id: "skip", name: "docs", conclusion: "SKIPPED"},
    {...legacy, isRequired: false}];
  const first = (await observe({checks: () => rollup(nodes)})).result;
  const reordered = (await observe({checks: () => rollup([...nodes].reverse())})).result;
  assert.equal(first.checks, "unknown");
  assert.equal(first.prerequisites, "unknown");
  assert.match(first.limitations.join(" "), /Classic branch protection/);
  assert.equal(first.fingerprint, reordered.fingerprint);
  assert.notEqual(first.fingerprint, (await observe({checks: () => rollup([legacy])})).result.fingerprint);
});

test("absent ruleset contexts, wrong source, in-progress jobs and ambiguous reruns", async () => {
  for (const nodes of [
    [{...run, name: "docs"}],
    [{...run, checkSuite: {app: {databaseId: 23}}, conclusion: "FAILURE"}],
    [{...run, checkSuite: {app: null}, conclusion: "FAILURE"}],
    [{...run, status: "IN_PROGRESS", conclusion: null}],
  ]) {
    assert.equal((await observe({checks: () => rollup(nodes)})).result.checks, "pending");
  }
  const rerun = (await observe({checks: () => rollup([run, {...run, id: "old", conclusion: "FAILURE"}])})).result;
  assert.equal(rerun.checks, "unknown");
  assert.match(rerun.limitations.join(" "), /ambiguous/);
  assert.equal((await observe({checks: () => rollup([{...legacy, state: "SUCCESS"}])})).result.checks, "unknown");
});

test("head is used only after verifying the test merge has no results, including during the read", async () => {
  const empty = {checks: (oid: string) => oid === merge ? null : rollup([legacy])};
  const {result, shaReads} = await observe(empty);
  assert.equal(result.checkSha, head);
  assert.equal(result.checks, "failed");
  assert.deepEqual(shaReads, [merge, head, merge]);
  for (const fixture of [
    {...empty, restCount: 1},
    {checks: (_: string, _after: string | null, call: number) => call === 1 ? rollup([]) : rollup([legacy])},
    {pull: () => ({...pull, potentialMergeCommit: null})},
    {pull: () => ({...pull, potentialMergeCommit: {oid: merge, parents: {nodes: [{oid: head}, {oid: base}]}}})},
  ]) {
    const result = (await observe(fixture)).result;
    assert.equal(result.checkSha, null);
    assert.equal(result.checks, "unknown");
    assert.match(result.limitations.join(" "), /effective required checks/);
  }
});

test("draft, review and conflict evidence survives a rule permission or check page failure", async () => {
  const {result} = await observe({
    pull: () => ({...pull, isDraft: true, reviewDecision: "CHANGES_REQUESTED", mergeable: "CONFLICTING", isMergeQueueEnabled: true}),
    rules: () => Response.json({message: "denied"}, {status: 403}),
    checks: () => rollup([legacy], 401, "cursor"),
  });
  assert.equal(result.checks, "unknown");
  assert.equal(result.mergeability, "conflicts");
  assert.equal(result.prerequisites, "unsatisfied");
  for (const reason of ["rulesets", "effective required checks", "draft", "further review", "merge queue"]) {
    assert.ok(result.limitations.join(" ").includes(reason));
  }
});

test("a later head, base, or closed PR invalidates earlier blockers", async () => {
  for (const changed of [{headRefOid: merge}, {baseRefOid: merge}, {state: "CLOSED"}]) {
    const {result} = await observe({pull: call => call === 1 ? pull : {...pull, ...changed}, checks: () => rollup([legacy])});
    assert.equal(result.freshness, "stale");
    assert.equal(result.checkSha, null);
    assert.equal(result.checks, "unknown");
    assert.equal(result.mergeability, "unknown");
    assert.equal(result.base, base);
    assert.equal(result.head, head);
  }
});

test("a regenerated test merge invalidates its previous checks and preserves current conflict evidence", async () => {
  const {result} = await observe({
    pull: call => call === 1 ? pull : {...pull, potentialMergeCommit: null, mergeable: "CONFLICTING"},
    checks: () => rollup([legacy]),
  });
  assert.equal(result.mergeability, "conflicts");
  assert.equal(result.freshness, "current");
  assert.equal(result.checks, "unknown");
  assert.equal(result.checkSha, null);
  assert.match(result.limitations.join(" "), /test merge changed/);
});

test("required checks and active rules are paginated with explicit gaps on incomplete inventory", async () => {
  const pages: number[] = [];
  const rules = (page: number) => {
    pages.push(page);
    return page === 1 ? Response.json([], {headers: {link: '<https://api.github.com/next>; rel="next"'}}) : Response.json([rule]);
  };
  const paged = await observe({rules, checks: (_oid, after) => after ? rollup([legacy], 2) : rollup([run], 2, "cursor")});
  assert.equal(paged.result.checks, "failed");
  assert.deepEqual(pages, [1, 2]);
  const capped = await observe({
    rules: () => Response.json([], {headers: {link: '<https://api.github.com/next>; rel="next"'}}),
    checks: (_oid, after) => after ? rollup([run], 2) : rollup([run], 2, "cursor"),
  });
  assert.equal(capped.result.checks, "unknown");
  assert.match(capped.result.limitations.join(" "), /rulesets/);
  assert.match(capped.result.limitations.join(" "), /effective required checks/);
});
