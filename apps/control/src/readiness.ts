import { createHash } from "node:crypto";
import type { Octokit } from "@octokit/rest";
import type { MentionRequest } from "./intake.ts";
import type { Refs } from "./worker.ts";

export interface ReadinessObservation {
  base: string;
  head: string;
  observedAt: string;
  freshness: "current" | "stale" | "unknown";
  mergeability: "clean" | "conflicts" | "unknown";
  checks: "failed" | "pending" | "passed" | "not_required" | "unknown";
  prerequisites: "satisfied" | "unsatisfied" | "unknown";
  checkSha: string | null;
  limitations: string[];
  fingerprint: string;
}

type Facts = Omit<ReadinessObservation, "observedAt" | "fingerprint">;
function observation(facts: Facts, evidence: string[] = []): ReadinessObservation {
  const fingerprint = createHash("sha256").update(JSON.stringify([facts, evidence.sort()])).digest("hex");
  return { ...facts, observedAt: new Date().toISOString(), fingerprint };
}

export function unavailableReadiness(refs: Refs): ReadinessObservation {
  return observation({
    base: refs.base, head: refs.head, freshness: "unknown", mergeability: "unknown", checks: "unknown",
    prerequisites: "unknown", checkSha: null, limitations: ["GitHub readiness could not be verified."],
  });
}

const sha = /^[a-f0-9]{40}$/;
const prQuery = `query PerryPull($owner:String!, $repo:String!, $number:Int!) {
  repository(owner:$owner, name:$repo) {
    databaseId pullRequest(number:$number) {
      id number state baseRefName baseRefOid headRefOid isDraft mergeable mergeStateStatus reviewDecision isMergeQueueEnabled
      potentialMergeCommit { oid parents(first:3) {nodes {oid}} }
    }
  }
}`;
const checksQuery = `query PerryChecks($owner:String!, $repo:String!, $sha:GitObjectID!, $pr:ID!, $after:String) {
  repository(owner:$owner, name:$repo) {
    databaseId object(oid:$sha) { ... on Commit { oid statusCheckRollup { contexts(first:100, after:$after) {
      totalCount pageInfo {hasNextPage endCursor} nodes { __typename
        ... on CheckRun { id name isRequired(pullRequestId:$pr) status conclusion checkSuite {app {databaseId}} }
        ... on StatusContext { id context isRequired(pullRequestId:$pr) state }
      }
    } } } }
  }
}`;

type Pull = {
  id: string; number: number; state: string; baseRefName: string; baseRefOid: string; headRefOid: string;
  isDraft: boolean; mergeable: string; mergeStateStatus: string; reviewDecision: string | null; isMergeQueueEnabled: boolean;
  potentialMergeCommit: null | {oid: string; parents: {nodes: {oid: string}[]}};
};
type Required = {context: string; integration_id?: number | null};
type Check = {
  __typename: "CheckRun" | "StatusContext"; id: string; isRequired: boolean;
  name?: string; context?: string; status?: string; conclusion?: string | null; state?: string;
  checkSuite?: {app: {databaseId: number} | null} | null;
};
type CheckPage = {totalCount: number; nodes: Check[]; pageInfo: {hasNextPage: boolean; endCursor: string | null}};
type RepoResult<T> = {repository: {databaseId: number} & T};
const incompleteChecks = "The effective required checks could not be verified.";
const legacyGap = "Classic branch protection and all actor-specific merge restrictions have not been verified.";

async function requiredRules(api: Octokit, r: MentionRequest, branch: string, signal: AbortSignal) {
  const expected: Required[] = [];
  for (let page = 1; page <= 4; page++) {
    const response = await api.request("GET /repos/{owner}/{repo}/rules/branches/{branch}", {
      owner: r.owner, repo: r.repo, branch, page, per_page: 100, request: {signal},
    });
    if (!Array.isArray(response.data) || response.data.length > 100) throw new Error();
    for (const rule of response.data) {
      if (rule.type === "required_status_checks") {
        const entries = rule.parameters?.required_status_checks;
        if (!Array.isArray(entries) || entries.some(entry => typeof entry?.context !== "string" || !entry.context
          || (entry.integration_id != null && !Number.isSafeInteger(entry.integration_id)))) throw new Error();
        if (expected.length + entries.length > 400) throw new Error();
        expected.push(...entries);
      }
    }
    if (!response.headers.link?.includes('rel="next"')) return expected;
  }
  throw new Error();
}

async function readChecks(api: Octokit, r: MentionRequest, pr: string, oid: string, signal: AbortSignal) {
  const checks: Check[] = [];
  const ids = new Set<string>();
  let after: string | null = null;
  let count: number | undefined;
  for (let page = 0; page < 4; page++) {
    const data: RepoResult<{object: {oid: string; statusCheckRollup: {contexts: CheckPage} | null} | null}>
      = await api.graphql(checksQuery, {owner: r.owner, repo: r.repo, sha: oid, pr, after, request: {signal}});
    const commit = data.repository.object;
    if (String(data.repository.databaseId) !== r.repoId || commit?.oid !== oid) throw new Error();
    // A null rollup can also mean the API has no visible check information.
    // Confirm an empty test-merge commit independently before using head.
    if (commit.statusCheckRollup === null && page === 0) return null;
    const contexts = commit.statusCheckRollup?.contexts;
    if (!contexts || !Number.isSafeInteger(contexts.totalCount) || contexts.totalCount < 0 || contexts.totalCount > 400
      || (count !== undefined && count !== contexts.totalCount) || !Array.isArray(contexts.nodes) || contexts.nodes.length > 100) throw new Error();
    count = contexts.totalCount;
    for (const node of contexts.nodes) {
      if (!node || typeof node.id !== "string" || ids.has(node.id) || typeof node.isRequired !== "boolean"
        || !["CheckRun", "StatusContext"].includes(node.__typename)) throw new Error();
      ids.add(node.id);
      checks.push(node);
    }
    if (checks.length > count) throw new Error();
    if (contexts.pageInfo?.hasNextPage === false && checks.length === count) return checks;
    if (contexts.pageInfo?.hasNextPage !== true || !contexts.pageInfo.endCursor || contexts.pageInfo.endCursor === after) throw new Error();
    after = contexts.pageInfo.endCursor;
  }
  throw new Error();
}

// Observe checks from one immutable commit. A duplicate run of the same name
// and source could be a rerun, and cannot establish which result is current.
function classify(checks: Check[], expected: Required[] | null, evidence: string[], limitations: string[]): Facts["checks"] {
  const groups = new Map<string, string[]>();
  // A visible legacy status does not expose its App ID. Its presence alone
  // cannot establish that an App-specific context is missing.
  const missing = new Set(expected);
  for (const check of checks) {
    const run = check.__typename === "CheckRun";
    const name = run ? check.name : check.context;
    if (typeof name !== "string" || !name) throw new Error();
    const appId = run ? check.checkSuite?.app?.databaseId : undefined;
    const sameName = expected?.filter(rule => rule.context === name) ?? [];
    const matches = sameName.filter(rule => !appId || !rule.integration_id || rule.integration_id < 0 || rule.integration_id === appId);
    for (const match of matches) missing.delete(match);
    if (!check.isRequired || (run && sameName.length && !matches.length)) continue;
    const state = run ? (check.status === "COMPLETED" ? check.conclusion : check.status) : check.state;
    const key = JSON.stringify([name, check.__typename, appId]);
    const entries = groups.get(key) ?? [];
    entries.push(state ?? "UNKNOWN");
    groups.set(key, entries);
    evidence.push(JSON.stringify([key, state]));
  }
  const results = [...groups.values()];
  if (results.some(values => values.length > 1)) limitations.push("Repeated results from the same required check are ambiguous.");
  const unique = results.filter(values => values.length === 1).flat();
  if (unique.some(value => ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(value))) return "failed";
  if (unique.some(value => ["PENDING", "QUEUED", "IN_PROGRESS", "REQUESTED", "WAITING", "EXPECTED"].includes(value))) return "pending";
  if (missing.size) return "pending";
  // A rulesets-only inventory cannot establish that no additional classic
  // required contexts are expected. Successful observed runs never promote.
  return "unknown";
}

export async function collectReadiness(api: Octokit, r: MentionRequest, refs: Refs, signal: AbortSignal): Promise<ReadinessObservation> {
  const readPull = async () => {
    const data = await api.graphql<RepoResult<{pullRequest: Pull | null}>>(prQuery, {
      owner: r.owner, repo: r.repo, number: r.number, request: {signal},
    });
    const pr = data.repository.pullRequest;
    if (String(data.repository.databaseId) !== r.repoId || pr?.number !== r.number || !pr.id || !pr.baseRefName
      || !sha.test(pr.baseRefOid) || !sha.test(pr.headRefOid) || !["OPEN", "CLOSED", "MERGED"].includes(pr.state)) throw new Error();
    return pr;
  };
  const pr = await readPull();
  const facts: Facts = {
    base: refs.base, head: refs.head, freshness: "current", mergeability: "unknown", prerequisites: "unknown",
    checks: "unknown", checkSha: null, limitations: [],
  };
  const moved = (p: Pull) => p.state !== "OPEN" || p.headRefOid !== refs.head || p.baseRefOid !== refs.base;
  const stale = () => observation({
    ...facts, freshness: "stale", mergeability: "unknown", prerequisites: "unknown",
    checks: "unknown", checkSha: null, limitations: ["The pull request closed or its reviewed commits changed."],
  });
  if (moved(pr)) return stale();
  const evidence: string[] = [];
  const rules = await requiredRules(api, r, pr.baseRefName, signal).catch(() => null);
  if (rules === null) facts.limitations.push("The active branch rulesets could not be read completely.");
  else for (const item of rules) evidence.push(JSON.stringify(["required", item.context, item.integration_id ?? null]));
  try {
    const merge = pr.potentialMergeCommit;
    if (!merge || !sha.test(merge.oid) || merge.parents.nodes.length !== 2 || merge.parents.nodes[0]?.oid !== refs.base
      || merge.parents.nodes[1]?.oid !== refs.head) throw new Error();
    const verifiedChecks = async (oid: string) => {
      const checks = await readChecks(api, r, pr.id, oid, signal);
      if (checks !== null) return checks;
      const args = {owner: r.owner, repo: r.repo, ref: oid, per_page: 1, request: {signal}};
      const [runs, statuses] = await Promise.all([api.rest.checks.listForRef(args), api.rest.repos.listCommitStatusesForRef(args)]);
      if (runs.data.total_count !== 0 || !Array.isArray(statuses.data) || statuses.data.length) throw new Error();
      return [];
    };
    let oid = merge.oid;
    let checks = await verifiedChecks(oid);
    if (checks.length === 0) {
      oid = refs.head;
      checks = await verifiedChecks(oid);
      if ((await verifiedChecks(merge.oid)).length) throw new Error();
    }
    facts.checks = classify(checks, rules, evidence, facts.limitations);
    facts.checkSha = oid;
  } catch {
    facts.limitations.push(incompleteChecks);
  }
  signal.throwIfAborted();
  const latest = await readPull();
  if (moved(latest)) return stale();
  if (latest.id !== pr.id) return unavailableReadiness(refs);
  if (latest.baseRefName !== pr.baseRefName || latest.potentialMergeCommit?.oid !== pr.potentialMergeCommit?.oid) {
    facts.checks = "unknown";
    facts.checkSha = null;
    facts.limitations = ["The target branch or test merge changed while reading required checks."];
    evidence.length = 0;
  }
  if (latest.mergeable === "CONFLICTING") facts.mergeability = "conflicts";
  if (latest.mergeable === "MERGEABLE") facts.mergeability = "clean";
  const reviewNeeded = latest.reviewDecision === "REVIEW_REQUIRED" || latest.reviewDecision === "CHANGES_REQUESTED";
  const mergeBlocked = ["BLOCKED", "BEHIND", "DRAFT"].includes(latest.mergeStateStatus);
  if (latest.isDraft === true) facts.limitations.push("The pull request is a draft.");
  if (reviewNeeded) facts.limitations.push("GitHub requires further review.");
  if (latest.isMergeQueueEnabled === true) facts.limitations.push("The target branch uses a merge queue.");
  if (mergeBlocked) facts.limitations.push("GitHub reports a blocked or out-of-date merge.");
  if (latest.isDraft === true || reviewNeeded || mergeBlocked) facts.prerequisites = "unsatisfied";
  evidence.push(JSON.stringify([latest.baseRefName, latest.isDraft, latest.mergeStateStatus, latest.reviewDecision, latest.isMergeQueueEnabled]));
  facts.limitations.push(legacyGap);
  return observation(facts, evidence);
}
