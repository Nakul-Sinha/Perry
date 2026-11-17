import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { GitHubGateway, UncertainComment } from "../src/github.ts";
import type { MentionRequest } from "../src/intake.ts";

const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const trigger: MentionRequest = {
  installationId: "5", repoId: "17", owner: "Example", repo: "Tool", number: 3,
  sender: "maintainer", senderId: "7", commentId: "11", kind: "review", text: "review", isPR: true,
};
const path = "/repos/Example/Tool";
const api = "https://api.github.com";
const thread = api + path + "/issues/3";
const summaryMarker = "<!-- perry:5:17:3:summary -->";
const sender = { id: 7, type: "User" };
const bot = { id: 9, type: "Bot" };
const realComment = { id: 11, body: "@Perry review", user: sender, issue_url: thread };
const slot = { id: 15, user: bot, body: "old\n\n" + summaryMarker, issue_url: thread };
const repo = { id: 17, full_name: "Example/Tool", default_branch: "trunk" };
const a = "a".repeat(40), b = "b".repeat(40);
function token(permissions: object, repositories = [{ id: 17 }]) {
  return Response.json({
    token: "installation-fixture", expires_at: new Date(Date.now() + 3600000).toISOString(),
    permissions, repositories, repository_selection: "selected",
  });
}
function gateway(override?: (req: Request, url: URL) => Promise<Response | undefined> | Response | undefined) {
  const calls: string[] = [];
  const client = new GitHubGateway({ appId: "19", botId: "9", privateKey }, {
    fetch: async (input, init) => {
      const req = new Request(input, init);
      const url = new URL(req.url);
      assert.equal(url.origin, api);
      assert.equal(req.redirect, "error");
      const route = req.method + " " + url.pathname;
      calls.push(route);
      const response = await override?.(req, url);
      if (response) return response;
      if (route === "POST /app/installations/5/access_tokens") {
        const options = await req.json();
        assert.deepEqual(options.repository_ids, [17]);
        return token(options.permissions ?? { metadata: "read", issues: "write" });
      }
      if (route === "GET /installation/repositories") return Response.json({ total_count: 1, repositories: [repo] });
      if (route === "GET " + path) return Response.json(repo);
      if (route.endsWith("/collaborators/maintainer/permission")) return Response.json({ permission: "write", user: sender });
      if (route.endsWith("/issues/comments/11")) return Response.json(realComment);
      if (route === "GET " + path + "/pulls/3") return Response.json({ state: "open", number: 3, base: { sha: a, repo }, head: { sha: b, repo } });
      if (route.endsWith("/branches/trunk")) return Response.json({ commit: { sha: a } });
      throw new Error("Unexpected fixture route " + route);
    },
  });
  return { client, calls };
}

test("authorization binds current repo access, effective permission, actor, thread and parsed demand", async () => {
  assert.equal(await gateway().client.authorize(trigger), true);
  const denials: [string, object][] = [
    ["/installation/repositories", { total_count: 0, repositories: [] }],
    [path, { ...repo, id: 30 }],
    [path + "/collaborators/maintainer/permission", { permission: "read", role_name: "admin", user: sender }],
    [path + "/collaborators/maintainer/permission", { permission: "write", user: { ...sender, id: 23 } }],
    [path + "/issues/comments/11", { ...realComment, issue_url: thread + "0" }],
    [path + "/issues/comments/11", { ...realComment, body: "@Perry what changed?" }],
    [path + "/issues/comments/11", { ...realComment, user: bot }],
  ];
  for (const [pathname, data] of denials) {
    const {client} = gateway((_req, url) => url.pathname === pathname ? Response.json(data) : undefined);
    assert.equal(await client.authorize(trigger), false, pathname);
  }
});

test("PR refs and issue refs are pinned separately, and closed PRs decline review", async () => {
  const { client } = gateway();
  assert.deepEqual(await client.refs(trigger), { base: a, head: b, sameRepository: true });
  for (const headRepo of [{id: 42}, null]) {
    const external = gateway((_req, url) => url.pathname.endsWith("/pulls/3") ? Response.json({
      state: "open", number: 3, base: {sha: a, repo}, head: {sha: b, repo: headRepo},
    }) : undefined);
    assert.deepEqual(await external.client.refs(trigger), {base: a, head: b, sameRepository: false});
  }
  assert.deepEqual(await client.refs({...trigger, isPR: false, kind: "question"}), {base: a, head: a});
  const closed = gateway((_req, url) => url.pathname.endsWith("/pulls/3") ? Response.json({ state: "closed" }) : undefined);
  assert.equal(await closed.client.refs(trigger), null);
});

test("source tokens accept only the selected repo and read-only contents grant", async () => {
  const valid = gateway(async (req, url) => {
    if (!url.pathname.includes("access_tokens")) return;
    assert.deepEqual(await req.json(), { repository_ids: [17], permissions: { contents: "read" } });
    return token({ contents: "read", metadata: "read" });
  });
  assert.equal(await valid.client.sourceToken(trigger), "installation-fixture");
  for (const response of [token({ contents: "write" }), token({ contents: "read", issues: "write" }), token({ contents: "read" }, [{ id: 31 }])]) {
    const invalid = gateway(() => response);
    await assert.rejects(invalid.client.sourceToken(trigger), /source access is unavailable/);
  }
});

test("readiness requires the installed repository and respects a cancelled lease", async () => {
  const signal = new AbortController().signal;
  const denied = gateway((_req, url) => url.pathname === "/installation/repositories"
    ? Response.json({total_count: 0, repositories: []}) : undefined);
  const facts = await denied.client.readiness(trigger, {base: a, head: b}, signal);
  assert.equal(facts.freshness, "unknown");
  assert.equal(facts.prerequisites, "unknown");
  assert.ok(!denied.calls.some(call => call.endsWith("/graphql")));
  await assert.rejects(denied.client.readiness(trigger, {base: a, head: b}, AbortSignal.abort()));
});

test("paginated slot reconciliation updates only the owned comment on the selected thread", async () => {
  const { client, calls } = gateway(async (req, url) => {
    if (url.pathname.endsWith("/issues/3/comments") && req.method === "GET") {
      if (url.searchParams.get("page") === "2") return Response.json([slot]);
      const next = "<" + thread + "/comments?page=2>; rel=\"next\"";
      return Response.json([{ ...slot, id: 20, user: sender }, { ...slot, id: 21, body: slot.body + " suffix" }], {headers:{link:next}});
    }
    if (url.pathname.endsWith("/issues/comments/15") && req.method === "PATCH") {
      assert.equal((await req.json()).body, "complete\n\n" + summaryMarker);
      return Response.json(slot);
    }
  });
  assert.equal(await client.writeSlot(trigger, "summary", "complete", undefined, false), "15");
  assert.equal(calls.filter(call => call.endsWith("/issues/3/comments")).length, 2);
  assert.ok(!calls.some(call => call.startsWith("POST " + path)));
});

test("an ambiguous creation never repeats POST on recovery and can adopt the exact receipt", async () => {
  let posted: typeof slot | undefined;
  let visible = false;
  const { client, calls } = gateway(async (req, url) => {
    if (!url.pathname.endsWith("/issues/3/comments")) return;
    if (req.method === "GET") return Response.json(visible && posted ? [posted] : []);
    if (req.method === "POST") {
      posted = { ...slot, body: (await req.json()).body };
      throw new Error("Simulated lost response");
    }
  });
  await assert.rejects(client.writeSlot(trigger, "summary", "pending"), /could not be confirmed/);
  await assert.rejects(client.writeSlot(trigger, "summary", "pending", undefined, false), UncertainComment);
  visible = true;
  assert.equal(await client.writeSlot(trigger, "summary", "pending", undefined, false), "15");
  assert.equal(calls.filter(call => call === "POST " + path + "/issues/3/comments").length, 1);
});

test("a failed lookup leaves a new slot eligible for its first create", async () => {
  let attempts = 0;
  let reservations = 0;
  const { client, calls } = gateway(async (req, url) => {
    if (!url.pathname.endsWith("/issues/3/comments")) return;
    if (req.method === "GET") {
      if (++attempts === 1) throw new Error("Simulated lookup timeout");
      return Response.json([]);
    }
    assert.equal(reservations, 1);
    return Response.json({ ...slot, body: (await req.json()).body });
  });
  const send = () => client.writeSlot(trigger, "summary", "pending", undefined, true, undefined, async () => { reservations++; });
  await assert.rejects(send());
  assert.equal(reservations, 0);
  assert.equal(await send(), "15");
  assert.equal(calls.filter(call => call === "POST " + path + "/issues/3/comments").length, 1);
});

test("a lost lease fences publication and cancels an outstanding token request", async () => {
  const lease = new AbortController();
  const atListing = gateway((_req, url) => {
    if (url.pathname.endsWith("/issues/3/comments")) { lease.abort(); return Response.json([]); }
  });
  await assert.rejects(atListing.client.writeSlot(trigger, "summary", "review", undefined, true, lease.signal));
  assert.ok(!atListing.calls.some(call => call === "POST " + path + "/issues/3/comments"));

  const reading = new AbortController();
  const busy = gateway(async req => {
    reading.abort();
    assert.equal(req.signal.aborted, true);
    return token({contents: "read"});
  });
  await assert.rejects(busy.client.sourceToken(trigger, reading.signal), /source access is unavailable/);
  assert.equal(busy.calls.length, 1);
});

test("stored IDs cannot redirect replies and question slots bind to the triggering comment", async () => {
  for (const wrong of [{ ...slot, user: sender }, { ...slot, issue_url: thread + "2" }, { ...slot, body: "different" }]) {
    const { client, calls } = gateway((_req, url) => url.pathname.endsWith("/issues/comments/15") ? Response.json(wrong) : undefined);
    await assert.rejects(client.writeSlot(trigger, "summary", "replace", "15"), UncertainComment);
    assert.ok(!calls.some(call => call.startsWith("PATCH ")));
  }
  const { client } = gateway(async (req, url) => {
    if (url.pathname.endsWith("/issues/comments/11")) return Response.json({ ...realComment, body: "@Perry why?" });
    if (url.pathname.endsWith("/issues/3/comments") && req.method === "GET") return Response.json([slot]);
    if (url.pathname.endsWith("/issues/3/comments") && req.method === "POST") {
      const { body } = await req.json();
      assert.ok(body.endsWith("<!-- perry:5:17:3:answer-11 -->"));
      return Response.json({ ...slot, id: 31, body });
    }
  });
  assert.equal(await client.writeSlot({ ...trigger, kind: "question", text: "why?" }, "answer", "Here is the answer."), "31");
});

test("stale maintenance verifies installed repository and existing owned slot without the original trigger", async () => {
  const signal = new AbortController().signal;
  const observed = {base: a, head: b, closed: true};
  let body = slot.body;
  const {client, calls} = gateway(async (req, url) => {
    if (url.pathname.endsWith("/pulls/3")) return Response.json({state:"closed", number:3, head:{sha:b}, base:{sha:a, repo}});
    if (url.pathname.endsWith("/issues/comments/15")) {
      if (req.method === "PATCH") body = (await req.json()).body;
      return Response.json({...slot, body});
    }
  });
  assert.deepEqual(await client.observeReview(trigger, signal), observed);
  const patch = () => client.invalidateSlot(trigger, "summary", "15", {base:a,head:b}, observed, signal);
  await patch();
  await patch();
  assert.ok(body.endsWith(summaryMarker));
  assert.match(body, /HOLD \| 0\/10/);
  assert.match(body, /pull request was closed/);
  assert.equal(calls.filter(s => s.startsWith("PATCH ")).length, 1);
  assert.ok(!calls.some(s => s.endsWith("/comments/11") || s.includes("/collaborators/") || s.startsWith("POST " + path)));
  for (const deny of [
    (_req: Request, url: URL) => url.pathname === "/installation/repositories" ? Response.json({total_count:0, repositories:[]}) : undefined,
    (_req: Request, url: URL) => url.pathname.endsWith("/comments/15") ? Response.json({...slot,user:sender}) : undefined,
  ]) {
    const denied = gateway(deny);
    await assert.rejects(denied.client.invalidateSlot(trigger, "summary", "15", {base:a,head:b}, observed, signal));
    assert.ok(!denied.calls.some(s => s.startsWith("PATCH ") || s.startsWith("POST " + path)));
  }
});
