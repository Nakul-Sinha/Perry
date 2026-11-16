import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, chmod, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import { PairingStore } from "../src/pairing-store.ts";
import { issueCodeFile, runnerHandler } from "../src/pairing.ts";
import { runPairCommand } from "../../runner/src/pair-cli.ts";

const connectionString = process.env.PERRY_TEST_DATABASE_URL;
const scope = {installationId: "101", repoId: "202"};

test("HTTP enrollment consumes a scoped code and revocation rejects its bearer", {skip: !connectionString}, async t => {
  const admin = new Pool({connectionString});
  const schema = "perry_pair_http_" + randomUUID().replaceAll("-", "");
  await admin.query("CREATE SCHEMA " + schema);
  const pool = new Pool({connectionString, options: "-c search_path=" + schema});
  t.after(async () => {
    await pool.end();
    try {await admin.query("DROP SCHEMA IF EXISTS " + schema + " CASCADE");}
    finally {await admin.end();}
  });
  const store = new PairingStore(pool);
  await store.init();
  const handler = runnerHandler(store, scope);
  const server = createServer((req,res) => void handler(req,res).catch(() => res.writeHead(503).end()));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const origin = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  const {code} = await store.issue(scope);
  const pair = () => fetch(origin + "/runners/pair", {method:"POST",
    headers: {"Content-Type":"application/json"}, body: JSON.stringify({code})});
  const enrolled = await pair();
  assert.equal(enrolled.status, 201);
  assert.equal(enrolled.headers.get("cache-control"), "no-store");
  const runner = await enrolled.json();
  assert.equal((await pair()).status, 401);
  const status = () => fetch(origin + "/runners/me", {headers:{Authorization: "Bearer " + runner.token}});
  assert.deepEqual(await (await status()).json(), {runnerId: runner.runnerId, ...scope});
  assert.equal(await store.revoke(scope, runner.runnerId), true);
  assert.equal((await status()).status, 401);
  assert.equal((await fetch(origin + "/runners/pair", {method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({code, repoId:"404"})})).status,400);
  if (process.platform !== "win32") {
    const dir = await mkdtemp(join(tmpdir(), "perry-pair-cli-"));
    await chmod(dir, 0o700);
    t.after(() => rm(dir, {recursive:true,force:true}));
    const codeFile = join(dir,"code");
    const identity = join(dir,"identity");
    await issueCodeFile(store,scope,codeFile);
    const log = t.mock.method(console,"log",()=>{});
    await runPairCommand(["pair","--server",origin,"--code-file",codeFile,"--identity",identity]);
    await runPairCommand(["pair-status","--identity",identity]);
    assert.equal(log.mock.callCount(),2);
  }
});
