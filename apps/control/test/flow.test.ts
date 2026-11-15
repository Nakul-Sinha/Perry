import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { Pool } from "pg";
import type { CommentSlot } from "../src/github.ts";
import { webhookHandler, type MentionRequest } from "../src/intake.ts";
import { approvedCheck, runLocal } from "../src/local-runner.ts";
import { Store } from "../src/store.ts";
import { processMention } from "../src/worker.ts";

const connectionString = process.env.PERRY_TEST_DATABASE_URL;

test("signed mentions reach the runner, reconcile the PR pair and leave questions independent", {skip: !connectionString}, async t => {
  const root = await mkdtemp(join(tmpdir(), "perry-flow-"));
  t.after(() => rm(root, {recursive: true, force: true, maxRetries: 3}));
  const git = async (...args: string[]) => (await promisify(execFile)("git", args, {cwd: root, env: {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
  }})).stdout.trim();
  await git("init", "--template=", ".");
  const manifest = async (scripts: Record<string,string>) => writeFile(join(root, "package.json"), JSON.stringify({scripts}, null, 2));
  const commit = async () => {
    await git("add", ".");
    await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "update fixture scripts");
    return git("rev-parse", "HEAD");
  };
  await writeFile(join(root, "tax.mjs"), "export const TAX_RATE = 0.05;\n");
  await manifest({check: "npm run lint", lint: "node --version"});
  const base = await commit();
  await manifest({check: "npm run lint"});
  const head = await commit();
  // Production reads a bare cache. A checkout-only runner would miss this.
  await git("clone", "--bare", "--no-local", ".", "source.git");

  const schema = "perry_flow_" + randomUUID().replaceAll("-", "");
  const admin = new Pool({connectionString});
  const pool = new Pool({connectionString, options: "-c search_path=" + schema});
  t.after(async () => {
    await pool.end();
    try { await admin.query("DROP SCHEMA IF EXISTS " + schema + " CASCADE"); }
    finally { await admin.end(); }
  });
  await admin.query("CREATE SCHEMA " + schema);
  const store = new Store(pool);
  await store.init();
  const key = "synthetic-test-signature";
  const server = createServer(webhookHandler(key, (delivery, request) => store.accept(delivery, request)));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const url = "http://127.0.0.1:" + (server.address() as AddressInfo).port + "/webhooks/github";
  async function send(id: number, text: string, delivery = randomUUID()) {
    const user = {id: 7, login: "developer", type: "User"};
    const body = JSON.stringify({action: "created", installation: {id: 2}, repository: {
      id: 5, owner: {login: "example"}, name: "demo", full_name: "example/demo",
    }, issue: {number: 9, pull_request: {url: "fixture"}}, comment: {id, body: text, user}, sender: user});
    const res = await fetch(url, {method: "POST", body, headers: {
      "x-github-delivery": delivery, "x-github-event": "issue_comment",
      "x-hub-signature-256": "sha256=" + createHmac("sha256", key).update(body).digest("hex"),
    }});
    assert.equal(res.status, 202);
    await res.text();
  }

  const comments = new Map<string, {id: string; body: string}>();
  let runs = 0;
  let permission = true;
  let sameRepository = true;
  const github = {
    async authorize() { return permission; }, async refs() { return {base, head, sameRepository}; },
    async writeSlot(r: MentionRequest, slot: CommentSlot, body: string, receipt?: string, create = true,
      _signal?: AbortSignal, beforeWrite?: () => Promise<void>) {
      const name = slot === "answer" ? slot + r.commentId : slot;
      const old = comments.get(name);
      if (receipt) assert.equal(receipt, old?.id);
      if (!old) assert.ok(create);
      await beforeWrite?.();
      const id = old?.id ?? String(comments.size + 100);
      comments.set(name, {id, body});
      return id;
    },
  };
  const scope = {installationId: "2", repoId: "5"};
  const work = () => store.workOne((request, job) => processMention(request, job, github, async (r, refs, signal) => {
    runs++;
    return runLocal(join(root, "source.git"), r, refs, signal, undefined, approvedCheck("tests/tax.test.mjs", "tax.mjs"));
  }), scope);
  const delivery = randomUUID();
  await send(11, "@Perry review", delivery);
  await send(11, "@Perry review", delivery);
  await send(11, "@Perry review");
  assert.equal(await store.workOne(async () => assert.fail("wrong repository consumed a request"), {...scope, repoId: "8"}), false);
  assert.equal(await work(), true);
  assert.equal(await work(), false);
  assert.equal(runs, 1);
  assert.equal(comments.size, 2);
  assert.match(comments.get("summary")!.body, /DO NOT MERGE/);
  assert.match(comments.get("summary")!.body, /\d+\/10/);
  assert.match(comments.get("findings")!.body, /lint/);
  assert.match(comments.get("summary")!.body + comments.get("findings")!.body, /file absent/);
  assert.ok(comments.get("summary")!.body.includes(head));
  const pair = [...comments.entries()];
  await send(12, "@Perry --where is TAX_RATE?");
  await work();
  const answer = comments.get("answer12")!.body;
  assert.match(answer, /tax\.mjs:1/);
  assert.ok(answer.includes(head));
  assert.doesNotMatch(answer, /\/10/);
  assert.doesNotMatch(answer, /tax\.test\.mjs/);
  assert.deepEqual([...comments.entries()].slice(0, 2), pair);
  await send(13, "@Peryy review");
  await work();
  assert.deepEqual([...comments.entries()].slice(0, 2), pair);
  assert.equal(comments.size, 3);
  permission = false;
  await send(14, "@Perry review");
  await work();
  assert.equal(runs, 3);
  permission = true;
  sameRepository = false;
  await send(15, "@Perry review");
  await work();
  assert.match(comments.get("findings")!.body, /runtime check was skipped/);
  assert.doesNotMatch(comments.get("summary")!.body + comments.get("findings")!.body, /file absent/);
});

test("only operator-selected repository paths describe the runtime check", () => {
  assert.equal(approvedCheck(), undefined);
  assert.deepEqual(approvedCheck("test/tax.test.mjs"), {testPath: "test/tax.test.mjs"});
  for (const path of ["../tax.mjs", "/tax.mjs", ".git/tax.mjs", "-v", "src\\tax.mjs", "src\n/tax.mjs", "tax.test.mjs"]) {
    assert.throws(() => approvedCheck("tax.test.mjs", path));
  }
  assert.throws(() => approvedCheck(undefined, "tax.mjs"));
});
