import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { Pool } from "pg";
import { PairingStore } from "../src/pairing-store.ts";
import { RemoteStore } from "../src/remote-store.ts";
import { remoteHandler, awaitRemote } from "../src/remote.ts";
import { runRemoteOnce } from "../../runner/src/remote-runner.ts";
import { Store } from "../src/store.ts";
import { processMention } from "../src/worker.ts";
import type { MentionRequest } from "../src/intake.ts";

const connectionString = process.env.PERRY_TEST_DATABASE_URL;
const scope = {installationId:"101",repoId:"202"};
const request: MentionRequest = {...scope, owner:"fixture",repo:"demo",number:4,commentId:"11",
  sender:"developer",senderId:"12",kind:"review",text:"review",isPR:true};
const refs = {base:"a".repeat(40),head:"b".repeat(40),sameRepository:true};

test("a scoped outbound runner completes a durable mention and returns its pair for publication", {skip:!connectionString,timeout:20000}, async t => {
  const schema = "perry_remote_http_" + randomUUID().replaceAll("-","");
  const admin = new Pool({connectionString});
  await admin.query("CREATE SCHEMA " + schema);
  const pool = new Pool({connectionString,options:"-c search_path=" + schema});
  t.after(async () => {
    await pool.end();
    try {await admin.query("DROP SCHEMA IF EXISTS " + schema + " CASCADE");}
    finally {await admin.end();}
  });
  const pairs = new PairingStore(pool);
  const remote = new RemoteStore(pool);
  const mentions = new Store(pool);
  await pairs.init(); await remote.init(); await mentions.init();
  const {code} = await pairs.issue(scope);
  const runner = (await pairs.pair(scope,code))!;
  let authorised = true;
  let revokeOnGrant = false;
  let grants = 0;
  const github = {
    async authorize() {return authorised;}, async refs() {return refs;},
    async sourceToken() {
      grants++;
      if (revokeOnGrant) await pairs.revoke(scope,runner.runnerId);
      return "synthetic-source-grant";
    },
  };
  const handler = remoteHandler(pairs,remote,github,scope);
  const server = createServer((req,res) => void handler(req,res).catch(() => res.writeHead(503).end()));
  await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const id = {...scope,...runner,origin:"http://127.0.0.1:" + (server.address() as AddressInfo).port};
  const submitted = {summary:"## Perry review\n\n**HOLD | 4/10 merge readiness (provisional)**",
    findings:"## Bugs and suggested fixes\n\nNo supported issue."};
  const cancel = new AbortController();
  const published: string[] = [];
  await mentions.accept("delivery",request);
  let entered!: () => void;
  const ready = new Promise<void>(resolve => {entered=resolve;});
  const publishing = mentions.workOne((r,job) => processMention(r,job,{
    ...github,
    async writeSlot(_r,slot,body,known,_create,_signal,reserve) {
      await reserve?.();
      published.push(body);
      return known ?? (slot === "summary" ? "901" : "902");
    },
  }, async (r,rev,signal) => {
    await remote.enqueue(r,rev);
    entered();
    return awaitRemote(remote,r,rev,signal);
  }),scope);
  await ready;
  let assessed = 0;
  assert.equal(await runRemoteOnce(id,cancel.signal,async job => {
    assessed++;
    assert.deepEqual(job.refs,refs);
    assert.equal(job.request.commentId,request.commentId);
    assert.equal(job.sourceToken,"synthetic-source-grant");
    return submitted;
  }),true);
  assert.equal(await publishing,true);
  assert.equal(assessed,1);
  assert.equal(published.length,3);
  assert.ok(published.at(-1)!.includes(refs.head));
  assert.ok(!published.join("").includes(id.token));

  authorised = false;
  const declined = await remote.enqueue({...request,commentId:"20"},refs);
  assert.equal(await runRemoteOnce(id,cancel.signal,async()=>assert.fail("revoked requester received work")),false);
  await assert.rejects(remote.result(declined),/cancel/i);
  assert.equal(grants,1);

  authorised = true; revokeOnGrant = true;
  await remote.enqueue({...request,commentId:"21"},refs);
  await assert.rejects(runRemoteOnce(id,cancel.signal,async()=>assert.fail("revoked runner received a source token")));
});
