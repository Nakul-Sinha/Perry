import assert from "node:assert/strict";
import { test } from "node:test";
import { checkReview, processMention, type Bodies, type Observation, type Refs, type ReviewWatch } from "../src/worker.ts";
import type { CommentSlot } from "../src/github.ts";
import type { MentionRequest } from "../src/intake.ts";
import type { Job } from "../src/store.ts";
import { reviseReadiness, unavailableReadiness, type ReadinessObservation } from "../src/readiness.ts";

const request: MentionRequest = {
  installationId: "17", repoId: "19", owner: "fixture", repo: "demo", number: 2, sender: "dev",
  senderId: "11", commentId: "13", kind: "review", isPR: true, text: "review",
};
const refs = {base: "a".repeat(40), head: "b".repeat(40)};
const facts = {...unavailableReadiness(refs), observedAt:"2026-11-17T00:00:00.000Z"};
function harness() {
  const slots = new Map<CommentSlot, string>();
  const comments = new Map<CommentSlot, {id:string; body:string}>();
  const writes: CommentSlot[] = [];
  let stored: unknown = null;
  const job: Job = {
    signal: new AbortController().signal,
    async loadResult<T>() { return stored as T | null; }, async saveResult(result) { stored = result; },
    async getSlot(slot) { return slots.get(slot) ?? null; },
    async markCreating(slot) { assert.ok(!slots.has(slot)); slots.set(slot, "creating"); },
    async saveSlot(slot, id) { slots.set(slot, id); },
  };
  const gateway = {
    async authorize() { return true; }, async refs(): Promise<Refs | null> { return refs; },
    async readiness(): Promise<ReadinessObservation> { return facts; },
    async writeSlot(_r: MentionRequest, slot: CommentSlot, body: string, id?: string, canCreate = true,
      _signal?: AbortSignal, reserve?: () => Promise<void>) {
      const existing = comments.get(slot);
      if (id) assert.equal(id, existing?.id);
      if (!existing) assert.ok(canCreate);
      await reserve?.();
      const result = existing?.id ?? String(comments.size + 1);
      comments.set(slot, {id:result, body}); writes.push(slot);
      return result;
    },
  };
  return {job, slots, comments, writes, gateway};
}

test("an ambiguous findings create resumes from the stored result and reuses both slots", async () => {
  const h = harness();
  const write = h.gateway.writeSlot.bind(h.gateway);
  let lost = true;
  h.gateway.writeSlot = async (...args) => {
    const id = await write(...args);
    if (args[1] === "findings" && lost) { lost = false; throw new Error("Lost receipt"); }
    return id;
  };
  let runs = 0;
  const evaluate = async () => { runs++; return {summary: "DO NOT MERGE | 4/10", findings:"Evidence"}; };
  await assert.rejects(processMention(request, h.job, h.gateway, evaluate), /Lost receipt/);
  assert.match(h.comments.get("summary")!.body, /HOLD \| 0\/10/);
  await processMention(request, h.job, h.gateway, evaluate);
  assert.equal(runs, 1);
  assert.equal(h.comments.size, 2);
  assert.match(h.comments.get("summary")!.body, /DO NOT MERGE \| 4\/10/);
});

test("a changed head between findings and final summary leaves a dated HOLD", async () => {
  const h = harness();
  h.gateway.refs = async () => h.comments.has("findings") ? {...refs, head:"c".repeat(40)} : refs;
  await processMention(request, h.job, h.gateway, async () => ({summary:"previous rating",findings:"previous evidence"}));
  assert.deepEqual(h.writes, ["summary", "findings", "summary"]);
  assert.match(h.comments.get("summary")!.body, /HOLD \| 0\/10/);
  assert.ok(h.comments.get("summary")!.body.includes(refs.head));
});

test("a question pins its answer and identifies a head changed during assessment", async () => {
  const h = harness();
  let reads = 0;
  h.gateway.refs = async () => ++reads === 1 ? refs : {...refs,head:"c".repeat(40)};
  await processMention({...request,kind:"question",text:"where is total?"},h.job,h.gateway,async()=>({answer:"## Perry answer\n\nCited source"}));
  assert.deepEqual(h.writes,["answer"]);
  assert.ok(h.comments.get("answer")!.body.includes(refs.head));
  assert.match(h.comments.get("answer")!.body,/source changed/);
});

test("revoked requests do no work; questions only use their answer slot", async () => {
  const h = harness();
  h.gateway.authorize = async () => false;
  const never = async (): Promise<Bodies> => { throw new Error("unexpected invocation"); };
  await processMention(request, h.job, h.gateway, never);
  assert.deepEqual(h.writes, []);
  h.gateway.authorize = async () => true;
  await processMention({...request,kind:"question",text:"where is total?"}, h.job, h.gateway, async () => ({answer:"Cited answer"}));
  assert.deepEqual(h.writes, ["answer"]);
});

test("periodic checks use both SHAs, fence a pending review and resume a partial edit", async () => {
  const changed = { ...refs, base:"c".repeat(40), closed:false };
  const watch: ReviewWatch = {
    request, refs, observed:null, summary:"500", findings:"501", signal:new AbortController().signal,
    assessmentSummary:"original", readiness:null, pendingReadiness:null,
    async begin(observed) { this.observed = observed; return true; },
    async beginReadiness() { return assert.fail("Unexpected readiness revision"); },
    async finishReadiness() { assert.fail("Unexpected readiness publication"); },
  };
  const writes: string[] = [];
  let now: Observation = {...refs, closed:false};
  let reads = 0;
  let reject = true;
  const gateway = {
    async observeReview() { reads++; return now; },
    async invalidateSlot(_r: MentionRequest, slot: "summary"|"findings", id:string, reviewed:Refs, observed:Observation) {
      assert.equal(id, watch[slot]);
      assert.deepEqual(reviewed, refs);
      assert.deepEqual(observed, changed);
      assert.deepEqual(watch.observed, changed);
      writes.push(slot);
      if (slot === "findings" && reject) throw new Error("Lost update receipt");
    },
  };
  assert.equal(await checkReview(watch, gateway), false);
  now = changed;
  assert.equal(await checkReview({...watch, begin: async () => false}, gateway), false);
  assert.deepEqual(writes, []);
  await assert.rejects(checkReview(watch, gateway), /Lost update/);
  assert.deepEqual(writes, ["summary", "findings"]);
  now = {...refs,closed:false};
  reject = false;
  assert.equal(await checkReview(watch, gateway), true);
  assert.equal(reads, 3);
  assert.deepEqual(writes, ["summary","findings","summary","findings"]);
});

test("publication reads readiness after findings and preserves the immutable source result", async () => {
  const h = harness();
  const source = "## Perry review\n\n**HOLD | 7/10 merge readiness (provisional)**\n\nGitHub mergeability unknown, required checks unknown, merge prerequisites unknown.\n\nCoverage: 1/1 changed paths checked. GitHub required checks: unknown.";
  h.gateway.readiness = async () => {
    assert.ok(h.comments.has("findings"));
    return {...facts, freshness:"current", checks:"failed", checkSha:refs.head, fingerprint:"failed"};
  };
  const result = await processMention(request, h.job, h.gateway, async () => ({summary:source, findings:"## Bugs and suggested fixes\n\nNo verified bugs found."}));
  assert.match(h.comments.get("summary")!.body, /DO NOT MERGE \| 4\/10/);
  assert.doesNotMatch(h.comments.get("summary")!.body, /required checks unknown/);
  assert.match(h.comments.get("summary")!.body, /required checks failed/);
  assert.equal((await h.job.loadResult<{bodies:{summary:string}}>())!.bodies.summary, source);
  assert.equal(result?.readiness?.facts.fingerprint, "failed");
});

test("failed source assessments stay provisional zero while source blockers survive live recovery", () => {
  const failed = {...facts, freshness:"current" as const, checks:"failed" as const, mergeability:"conflicts" as const};
  for (const summary of ["## Perry review\n\n**HOLD | 0/10 merge readiness (provisional)**\n\nAssessment failed.", "malformed summary"]) {
    assert.match(reviseReadiness(summary, failed).summary, /HOLD \| 0\/10/);
  }
  const material = "## Perry review\n\n**DO NOT MERGE | 3/10 merge readiness (provisional)**\n\n1 material finding, incomplete coverage.";
  assert.match(reviseReadiness(material, {...facts, checks:"passed", prerequisites:"satisfied", mergeability:"clean", freshness:"current"}).summary, /DO NOT MERGE \| 3\/10/);
  assert.match(reviseReadiness("## Perry review\n\n**MERGE | 10/10 merge readiness**", {...facts, checks:"passed", prerequisites:"satisfied", mergeability:"clean", freshness:"current"}).summary, /HOLD \| 7\/10/);
});

test("same-commit readiness recovers a lost update, skips unchanged facts and restores only source score", async () => {
  const original = "## Perry review\n\n**HOLD | 7/10 merge readiness (provisional)**\n\nGitHub mergeability unknown, required checks unknown, merge prerequisites unknown.";
  const watch: ReviewWatch = {
    request, refs, observed:null, summary:"500", findings:"501", signal:new AbortController().signal,
    assessmentSummary:original, readiness:reviseReadiness(original, facts), pendingReadiness:null,
    async begin(observed) { this.observed = observed; return true; },
    async beginReadiness(revision) { assert.equal(this.pendingReadiness,null); this.pendingReadiness=revision; return true; },
    async finishReadiness() { assert.ok(this.pendingReadiness); this.readiness=this.pendingReadiness; this.pendingReadiness=null; },
  };
  let current: ReadinessObservation = {...facts, freshness:"current", checks:"failed", fingerprint:"failed"};
  const writes: string[] = [];
  let lost = true;
  const gateway = {
    async observeReview() { return {...refs,closed:false}; },
    async readiness() { return current; },
    async invalidateSlot() { assert.fail("Unexpected source invalidation"); },
    async refreshSummary(_r:MentionRequest, id:string, requested:Refs, body:string) {
      assert.equal(id,"500"); assert.deepEqual(requested,refs);
      assert.ok(watch.pendingReadiness);
      writes.push(body);
      if (lost) { lost=false; throw new Error("Lost update receipt"); }
      return null;
    },
  };
  await assert.rejects(checkReview(watch,gateway), /Lost update/);
  assert.match(watch.pendingReadiness!.summary, /DO NOT MERGE \| 4\/10/);
  const restarted = {...watch};
  assert.equal(await checkReview(restarted,gateway),false);
  assert.equal(writes.length,2);
  assert.equal(writes[0],writes[1]);
  assert.equal(restarted.pendingReadiness,null);
  assert.equal(await checkReview(restarted,gateway),false);
  assert.equal(writes.length,2);
  current={...facts, freshness:"current", checks:"pending", fingerprint:"pending"};
  assert.equal(await checkReview(restarted,gateway),false);
  assert.match(writes.at(-1)!, /HOLD \| 7\/10/);
  current={...facts, freshness:"current", checks:"passed", prerequisites:"satisfied", mergeability:"clean", fingerprint:"passed"};
  await checkReview(restarted,gateway);
  assert.match(writes.at(-1)!, /HOLD \| 7\/10/);
  assert.equal(restarted.assessmentSummary, original);
});

test("readiness source movement invalidates both slots before any new summary", async () => {
  const writes: string[]=[];
  const watch: ReviewWatch = {
    request, refs, observed:null, summary:"500", findings:"501", signal:new AbortController().signal,
    assessmentSummary:"source", readiness:null, pendingReadiness:null,
    async begin(observed) { this.observed=observed; return true; },
    async beginReadiness() { return assert.fail("Unexpected readiness revision"); },
    async finishReadiness() { assert.fail("Unexpected readiness completion"); },
  };
  let reads=0;
  const gateway={
    async observeReview() { return {...refs,head:++reads===1?refs.head:"c".repeat(40),closed:false}; },
    async readiness() { return {...facts,freshness:"stale" as const}; },
    async invalidateSlot(_r:MentionRequest,slot:"summary"|"findings") { writes.push(slot); },
    async refreshSummary() { return assert.fail("Unexpected readiness summary"); },
  };
  assert.equal(await checkReview(watch,gateway),true);
  assert.deepEqual(writes,["summary","findings"]);
  assert.equal(watch.observed!.head,"c".repeat(40));
});

test("movement at maintenance dispatch invalidates both slots and retains the pending revision", async () => {
  const changed={...refs,head:"c".repeat(40),closed:false};
  const writes:string[]=[];
  const watch:ReviewWatch={
    request,refs,observed:null,summary:"500",findings:"501",signal:new AbortController().signal,
    assessmentSummary:"## Perry review\n\n**HOLD | 7/10 merge readiness**",readiness:null,pendingReadiness:null,
    async begin(observed){this.observed=observed;return true;},
    async beginReadiness(revision){this.pendingReadiness=revision;return true;},
    async finishReadiness(){assert.fail("The moved summary must not be confirmed");},
  };
  const gateway={
    async observeReview(){return {...refs,closed:false};},
    async readiness(){return facts;},
    async refreshSummary(){assert.ok(watch.pendingReadiness);return changed;},
    async invalidateSlot(_r:MentionRequest,slot:"summary"|"findings"){writes.push(slot);},
  };
  assert.equal(await checkReview(watch,gateway),true);
  assert.deepEqual(writes,["summary","findings"]);
  assert.deepEqual(watch.observed,changed);
});
