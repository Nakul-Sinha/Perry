import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { test } from "node:test";
import { runRemote, runRemoteOnce } from "../src/remote-runner.ts";

const opaque = () => randomBytes(32).toString("base64url");
const id = {runnerId:randomUUID(), origin:"https://perry.example", token:opaque(), installationId:"51", repoId:"62"};
const request = {installationId:id.installationId, repoId:id.repoId, owner:"sample", repo:"app", number:3,
  isPR:true, kind:"review", text:"review", sender:"author", senderId:"4", commentId:"5"};
const refs = {base:"a".repeat(40), head:"b".repeat(40), sameRepository:false};
const job = () => ({jobId:randomUUID(), leaseToken:opaque(), sourceToken:opaque(), request, refs});
const review = {summary:"## Perry review\n\nHOLD | 3/10", findings:"An unhandled case."};
const waiting = async (_ms: number, signal: AbortSignal) => { await once(signal, "abort"); };
const ok = () => new Response(null,{status:204});

test("accepts only scoped pinned jobs and uploads one matching review", async t => {
  const j = job();
  const paths: string[] = [];
  const work = t.mock.fn(async (value: typeof j) => {
    assert.deepEqual(value.refs, refs);
    assert.equal(value.sourceToken, j.sourceToken);
    return review;
  });
  t.mock.method(globalThis,"fetch",async (url: string, init: RequestInit) => {
    assert.equal(init.redirect,"error");
    assert.equal(init.method,"POST");
    assert.ok(new Headers(init.headers).get("authorization") === "Bearer " + id.token);
    const path = new URL(url).pathname;
    paths.push(path);
    const body = JSON.parse(init.body as string);
    if (path.endsWith("/claim")) {
      assert.deepEqual(body,{});
      return Response.json(j);
    }
    assert.ok(body.leaseToken === j.leaseToken);
    assert.deepEqual(body.bodies,review);
    assert.ok(!Object.hasOwn(body,"sourceToken"));
    return ok();
  });
  assert.equal(await runRemoteOnce(id, new AbortController().signal, work as Parameters<typeof runRemoteOnce>[2],waiting),true);
  assert.equal(work.mock.callCount(),1);
  assert.deepEqual(paths,["/runners/jobs/claim","/runners/jobs/" + j.jobId + "/result"]);
});

test("idle claims and invalid or oversized jobs never start an assessment", async t => {
  const j = job();
  const work = t.mock.fn(async () => review);
  const stop = new AbortController();
  const invalid = [
    {...j,jobId:"../../elsewhere"}, {...j,leaseToken:"bad"}, {...j,request:{...request,repoId:"77"}},
    {...j,request:{...request,kind:"command"}}, {...j,request:{...request,repo:"../bad"}},
    {...j,refs:{...refs,base:"main"}}, {...j,refs:{...refs,sameRepository:"yes"}},
    {...j,request:{...request,isPR:false}}, {...j,sourceToken:"bad\nheader"},
  ];
  for (const response of [ok(), ...invalid.map(item => Response.json(item)),
    new Response("x".repeat(140_000),{headers:{"Content-Type":"application/json"}})]) {
    const send = t.mock.method(globalThis,"fetch",async () => response);
    if (response.status === 204) assert.equal(await runRemoteOnce(id,stop.signal,work,waiting),false);
    else await assert.rejects(runRemoteOnce(id,stop.signal,work,waiting));
    assert.equal(send.mock.callCount(),1);
    send.mock.restore();
  }
  assert.equal(work.mock.callCount(),0);
});

test("lease renewal failure cancels the assessment and suppresses upload", async t => {
  for (const status of [409,401,503]) {
    const j = job();
    const routes: string[] = [];
    const send = t.mock.method(globalThis,"fetch",async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      routes.push(path);
      if (path.endsWith("/claim")) return Response.json(j);
      assert.ok(path.endsWith("/heartbeat"));
      assert.ok(JSON.parse(init.body as string).leaseToken === j.leaseToken);
      return new Response(null,{status});
    });
    let aborted = false;
    let ms = 0;
    const run = runRemoteOnce(id,new AbortController().signal,async (_job,signal) => {
      await once(signal,"abort");
      aborted = signal.aborted;
      return review;
    },async delay => {ms = delay;});
    await assert.rejects(run,status === 401 ? /identity was rejected/ : /aborted/i);
    assert.equal(ms,15000);
    assert.equal(aborted,true);
    assert.deepEqual(routes,["/runners/jobs/claim","/runners/jobs/" + j.jobId + "/heartbeat"]);
    send.mock.restore();
  }
});

test("questions use the pinned repository branch and reject a credential, oversized, or wrong-shaped answer", async t => {
  for (const shape of ["good","leaked","oversized","wrong"]) {
    const j = {...job(),request:{...request,isPR:false,kind:"question",text:"Where is the handler?"},
      refs:{base:refs.base,head:refs.base}};
    let posted: Record<string, string> | undefined;
    const send = t.mock.method(globalThis,"fetch",async (url: string, init: RequestInit) => {
      if (url.endsWith("/claim")) return Response.json(j);
      posted = JSON.parse(init.body as string).bodies;
      return ok();
    });
    const answer = shape === "good" ? "It is in app.ts." : shape === "leaked" ? j.sourceToken : "x".repeat(59_000);
    await runRemoteOnce(id,new AbortController().signal,async (value) => {
      assert.equal(value.request.kind,"question");
      assert.equal(value.refs.sameRepository,false);
      return shape === "wrong" ? review : {answer};
    },waiting);
    assert.ok(posted && Object.keys(posted).join() === "answer");
    assert.ok(shape === "good" ? posted.answer === answer : posted.answer?.includes("could not assess"));
    assert.ok(!posted.answer?.includes(j.sourceToken));
    send.mock.restore();
  }
});

test("shutdown stops active work, while revocation terminates claim polling", async t => {
  const j = job();
  const stop = new AbortController();
  const send = t.mock.method(globalThis,"fetch",async () => Response.json(j));
  await assert.rejects(runRemoteOnce(id,stop.signal,async () => {stop.abort(); return review;},waiting));
  assert.equal(send.mock.callCount(),1);
  send.mock.restore();
  t.mock.method(globalThis,"fetch",async () => new Response(null,{status:401}));
  await assert.rejects(runRemoteOnce(id,new AbortController().signal,async () => review,waiting),/identity was rejected/);
});

test("a lost upload or acknowledgement retries the same receipt without reevaluating", async t => {
  for (const when of ["before","after"]) {
    const j = job();
    const receipts: string[] = [];
    let accepted: string | undefined;
    const calls = t.mock.method(globalThis,"fetch",async (url: string, init: RequestInit) => {
      if (url.endsWith("/claim")) return Response.json(j);
      assert.ok(url.endsWith("/" + j.jobId + "/result"));
      const body = String(init.body);
      receipts.push(body);
      if (receipts.length === 1) {
        if (when === "after") accepted = body;
        throw new Error("Simulated connection loss.");
      }
      if (accepted && accepted !== body) return new Response(null,{status:409});
      accepted = body;
      return ok();
    });
    const assess = t.mock.fn(async () => review);
    const delays: number[] = [];
    await runRemoteOnce(id,new AbortController().signal,assess,async (ms, signal) => {
      if (ms === 15_000) return waiting(ms,signal);
      delays.push(ms);
    });
    assert.deepEqual(delays,[500]);
    assert.equal(assess.mock.callCount(),1);
    assert.equal(receipts.length,2);
    assert.ok(receipts.every(receipt => receipt === accepted));
    calls.mock.restore();
  }
});

test("submit retries transient statuses within budget and stops immediately on revoked or stale leases", async t => {
  for (const status of [503,409,401,403]) {
    const j = job();
    const send = t.mock.method(globalThis,"fetch",async (url: string) => {
      if (url.endsWith("/claim")) return Response.json(j);
      return new Response(null,{status});
    });
    const assess = t.mock.fn(async () => review);
    const wait = async (ms: number, signal: AbortSignal) => {if (ms === 15_000) await waiting(ms,signal);};
    await assert.rejects(runRemoteOnce(id,new AbortController().signal,assess,wait),status === 401 || status === 403
      ? /identity was rejected/ : /did not accept/);
    assert.equal(send.mock.callCount(),status === 503 ? 4 : 2);
    assert.equal(assess.mock.callCount(),1);
    send.mock.restore();
  }
});

test("serve rejects ambiguous options and uses trusted provider and check validation", async () => {
  const args = ["serve","--identity","unused","--cache","unused"];
  await assert.rejects(runRemote([...args,"--cache","again"]),/Use serve/);
  await assert.rejects(runRemote([...args,"--openai-model","a","--anthropic-model","b"]),/exactly one model/);
  await assert.rejects(runRemote([...args,"--module","module.mjs"]),/repository-relative/);
});
