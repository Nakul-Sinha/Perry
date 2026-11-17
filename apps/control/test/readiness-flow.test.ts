import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import type { CommentSlot } from "../src/github.ts";
import type { MentionRequest } from "../src/intake.ts";
import { unavailableReadiness, type ReadinessObservation } from "../src/readiness.ts";
import { Store } from "../src/store.ts";
import { checkReview, processMention, type Observation } from "../src/worker.ts";

const connectionString = process.env.PERRY_TEST_DATABASE_URL;

test("durable readiness revisions recover lost writes and refresh CI without source inference", {skip:!connectionString}, async t => {
  const schema="perry_readiness_"+randomUUID().replaceAll("-","");
  const admin=new Pool({connectionString});
  await admin.query("CREATE SCHEMA "+schema);
  const options={connectionString,options:"-c search_path="+schema,max:3};
  const pool=new Pool(options), peer=new Pool(options);
  t.after(async()=>{
    await Promise.all([pool.end(),peer.end()]);
    try { await admin.query("DROP SCHEMA "+schema+" CASCADE"); }
    finally { await admin.end(); }
  });
  const store=new Store(pool), restarted=new Store(peer);
  await store.init();
  const scope={installationId:"17",repoId:"19"};
  const request:MentionRequest={...scope,owner:"fixture",repo:"demo",number:2,sender:"dev",senderId:"11",commentId:"13",kind:"review",isPR:true,text:"review"};
  const refs={base:"a".repeat(40),head:"b".repeat(40)};
  let observed:Observation={...refs,closed:false};
  let facts:ReadinessObservation=unavailableReadiness(refs);
  let runs=0, loseReceipt=false;
  const writes:string[]=[];
  const comments=new Map<CommentSlot,{id:string;body:string}>();
  const source="## Perry review\n\n**HOLD | 7/10 merge readiness (provisional)**\n\nGitHub mergeability unknown, required checks unknown, merge prerequisites unknown.\n\nCoverage: 1/1 changed paths checked. GitHub required checks: unknown.";
  const github={
    async authorize(r:MentionRequest) { return r.commentId!=="14"; },
    async refs() { return refs; },
    async observeReview() { return observed; },
    async readiness() { return facts; },
    async writeSlot(_r:MentionRequest,slot:CommentSlot,body:string,id?:string,create=true,_signal?:AbortSignal,reserve?:()=>Promise<void>) {
      const old=comments.get(slot);
      if(id) assert.equal(old?.id,id);
      if(!old) assert.equal(create,true);
      await reserve?.();
      const receipt=old?.id??String(comments.size+500);
      if(old?.body!==body) { comments.set(slot,{id:receipt,body}); writes.push(slot); }
      if(loseReceipt) { loseReceipt=false; throw new Error("Lost update receipt"); }
      return receipt;
    },
    async refreshSummary(r:MentionRequest,id:string,_refs:typeof refs,body:string) {
      if(observed.closed||observed.head!==refs.head||observed.base!==refs.base) return observed;
      await this.writeSlot(r,"summary",body,id,false);
      return null;
    },
    async invalidateSlot(_r:MentionRequest,slot:"summary"|"findings",id:string) {
      assert.equal(comments.get(slot)!.id,id);
      comments.set(slot,{id,body:"stale"}); writes.push(slot);
    },
  };
  const evaluate=async()=>{runs++;return {summary:source,findings:"## Bugs and suggested fixes\n\nNo verified bugs found within the reviewed scope."};};
  const process=(worker:Store)=>worker.workOne((r,job)=>processMention(r,job,github,evaluate),scope);
  const due=()=>pool.query("UPDATE perry_review_watches SET due_at=now()");
  const poll=(worker:Store)=>worker.pollOne(scope,watch=>checkReview(watch,github));
  await store.accept("first",request);
  assert.equal(await process(store),true);
  assert.equal(runs,1);
  assert.equal(comments.size,2);
  const baseline=(await pool.query("SELECT result FROM perry_mentions WHERE comment_id='13'")).rows[0].result;
  assert.equal(baseline.bodies.summary,source);
  const initialWrites=writes.length;
  await due(); await poll(store);
  assert.equal(writes.length,initialWrites);

  facts={...facts,freshness:"current",checks:"failed",checkSha:refs.head,fingerprint:"failed"};
  loseReceipt=true;
  await due(); await poll(store);
  assert.match(comments.get("summary")!.body,/DO NOT MERGE \| 4\/10/);
  let state=(await pool.query("SELECT readiness,pending_readiness,failures FROM perry_review_watches")).rows[0];
  assert.equal(state.readiness.facts.fingerprint,unavailableReadiness(refs).fingerprint);
  assert.equal(state.pending_readiness.facts.fingerprint,"failed");
  assert.equal(state.failures,1);
  await store.accept("queued",{...request,commentId:"14"});
  assert.equal(await process(restarted),false);
  const beforeRetry=writes.length;
  await due(); await poll(restarted);
  assert.equal(writes.length,beforeRetry);
  state=(await pool.query("SELECT pending_readiness,failures FROM perry_review_watches")).rows[0];
  assert.equal(state.pending_readiness,null);
  assert.equal(state.failures,0);
  assert.equal(await process(restarted),true);
  assert.equal(runs,1);

  facts={...facts,checks:"passed",mergeability:"clean",prerequisites:"satisfied",fingerprint:"passed",observedAt:"2026-11-17T01:00:00.000Z"};
  await due(); await poll(restarted);
  assert.match(comments.get("summary")!.body,/HOLD \| 7\/10/);
  assert.match(comments.get("summary")!.body,/required checks passed/);
  assert.equal(runs,1);
  const afterRecovery=writes.length;
  facts={...facts,observedAt:"2026-11-17T02:00:00.000Z"};
  await due(); await poll(restarted);
  assert.equal(writes.length,afterRecovery);
  assert.equal(comments.get("findings")!.id,"501");
  assert.deepEqual((await pool.query("SELECT result FROM perry_mentions WHERE comment_id='13'")).rows[0].result,baseline);

  observed={...refs,head:"c".repeat(40),closed:false};
  await due(); await poll(restarted);
  assert.deepEqual(writes.slice(-2),["summary","findings"]);
  assert.equal(comments.get("summary")!.body,"stale");
  assert.equal(comments.get("findings")!.body,"stale");
  assert.equal(runs,1);
  assert.equal((await pool.query("SELECT due_at FROM perry_review_watches")).rows[0].due_at,null);
});
