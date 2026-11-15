import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer, request as post } from "node:http";
import { once } from "node:events";
import { test, type TestContext } from "node:test";
import { parseMention, webhookHandler, type MentionRequest } from "../src/intake.ts";

const secret = "public-test-fixture";
const delivery = "00000000-1111-2222-3333-444444444444";
function payload(body = "@Perry review") {
  const actor = {id: 5, type: "User", login: "ada"};
  return {
    action: "created", installation: {id: 1},
    repository: {id: 2, name: "Example", owner: {login: "team"}, full_name: "team/Example"},
    issue: {number: 3, pull_request: {url: "https://api.github.com/repos/team/Example/pulls/3"}},
    comment: {id: 4, body, user: {...actor}}, sender: {...actor},
  };
}

async function setup(t: TestContext, accept: (id: string, req: MentionRequest) => Promise<void>) {
  const server = createServer(webhookHandler(secret, accept)).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const addr = server.address();
  assert.ok(addr && typeof addr !== "string");
  return (raw: string | Buffer, headers: Record<string, string> = {}, chunked = false) => new Promise<number>((resolve, reject) => {
    const signature = createHmac("sha256", secret).update(raw).digest("hex");
    const req = post({ hostname: "127.0.0.1", port: addr.port, path: "/webhooks/github", method: "POST",
      headers: { "x-github-event": "issue_comment", "x-github-delivery": delivery,
        "x-hub-signature-256": "sha256=" + signature, ...headers } }, res => {
      res.resume();
      res.on("end", () => resolve(res.statusCode!));
    });
    req.on("error", reject);
    if (chunked) { req.write(raw); req.end(); }
    else req.end(raw);
  });
}

test("requires a direct address outside quotations and code", () => {
  assert.deepEqual(parseMention("\n @Peryy: Review ", true), {kind: "review", text: "Review"});
  assert.deepEqual(parseMention("@Perry review", false), {kind: "clarification", text: "review"});
  assert.deepEqual(parseMention("@Perry why is `read()` async?", false), {kind: "question", text: "why is `read()` async?"});
  for (const example of ["> @Perry review", "`@Perry review`", "```txt\n@Perry review\n```",
    "    @Perry review", "\t@Perry review", "@Perryman review", "Example: @Perry review", "@Perry", "<!-- @Perry review -->"]) {
    assert.equal(parseMention(example, true), null, example);
  }
});

test("authenticates exact UTF-8 bytes and passes a scoped request to storage", async t => {
  const jobs: MentionRequest[] = [];
  const send = await setup(t, async (id, command) => { assert.equal(id, delivery); jobs.push(command); });
  const body = JSON.stringify(payload("@Perry où est défini read()?"), null, 2);
  assert.equal(await send(body), 202);
  assert.deepEqual(jobs, [{
    installationId: "1", repoId: "2", owner: "team", repo: "Example", number: 3, commentId: "4",
    sender: "ada", senderId: "5", kind: "question", text: "où est défini read()?", isPR: true,
  }]);
  const bad = "sha256=" + createHmac("sha256", secret).update(body.trim() + "\n").digest("hex");
  assert.equal(await send(body, {"x-hub-signature-256": bad}), 401);
  assert.equal(await send(body, {"x-hub-signature-256": "bad"}), 401);
  assert.equal(jobs.length, 1);
});

test("ignores unrelated events, edited comments, bots and mismatched actors", async t => {
  let calls = 0;
  const send = await setup(t, async () => { calls++; });
  const event = payload();
  assert.equal(await send(JSON.stringify(event), {"x-github-event": "issues"}), 204);
  for (const changed of [
    {...event, action: "edited"}, {...event, sender: {...event.sender, type: "Bot"}},
    {...event, sender: {...event.sender, id: 6}}, {...event, comment: {...event.comment, body: "`@Perry review`"}},
  ]) assert.equal(await send(JSON.stringify(changed)), 204);
  assert.equal(calls, 0);
});

test("rejects unsafe IDs, repository mismatches, invalid bytes and oversized requests", async t => {
  let calls = 0;
  const send = await setup(t, async () => { calls++; });
  const event = payload();
  for (const changed of [
    {...event, repository: {...event.repository, full_name: "another/Example"}},
    {...event, repository: {...event.repository, name: "..", full_name: "team/.."}},
    {...event, repository: {...event.repository, id: 9007199254740992}},
    {...event, installation: {id: -1}}, {...event, issue: {number: 1.1}},
  ]) assert.equal(await send(JSON.stringify(changed)), 400);
  assert.equal(await send("}"), 400);
  assert.equal(await send(Buffer.from([0xc3])), 400);
  assert.equal(await send(JSON.stringify(event), {"x-github-delivery": "invalid"}), 400);
  assert.equal(await send("a".repeat(300_000)), 413);
  assert.equal(await send("a".repeat(300_000), {}, true), 413);
  assert.equal(calls, 0);
});

test("storage failure stays retryable and an acknowledgement waits for persistence", async t => {
  let attempts = 0;
  const entered = Promise.withResolvers<void>();
  const persisted = Promise.withResolvers<void>();
  const send = await setup(t, async () => {
    if (++attempts === 1) throw new Error("storage unavailable");
    entered.resolve();
    await persisted.promise;
  });
  const body = JSON.stringify(payload());
  assert.equal(await send(body), 503);
  let received = false;
  const retry = send(body).then(status => { received = true; return status; });
  await entered.promise;
  assert.equal(received, false);
  persisted.resolve();
  assert.equal(await retry, 202);
});
