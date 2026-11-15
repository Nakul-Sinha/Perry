import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { prepareCache } from "../src/cache.ts";
import type { MentionRequest } from "../src/intake.ts";

const request: MentionRequest = {
  installationId: "12", repoId: "34", owner: "example", repo: "project", number: 8,
  commentId: "15", sender: "viewer", senderId: "17", kind: "review", text: "review", isPR: true,
};
const url = "https://github.com/example/project.git";
const token = "fixture-installation-access";
const signal = new AbortController().signal;
type Execute = NonNullable<Parameters<typeof prepareCache>[5]>;
const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
function git(dir: string, args: string[], vars: NodeJS.ProcessEnv = env) {
  return execFileSync("git", args, {cwd: dir, env: vars, encoding: "utf8", windowsHide: true, stdio: ["ignore","pipe","ignore"]}).trim();
}
async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "perry-cache-"));
  t.after(() => rm(dir, {force: true, recursive: true}));
  git(dir, ["init", "-q", "--template=", "."]);
  const commit = (s: string) => {
    git(dir, ["add", "source"]);
    git(dir, ["-c", "user.name=Fixture", "-c", "user.email=test@example.invalid", "commit", "-qm", s]);
    return git(dir, ["rev-parse", "HEAD"]);
  };
  await writeFile(join(dir, "source"), "before");
  const base = commit("add sample source");
  await writeFile(join(dir, "source"), "after");
  const head = commit("update sample source");
  git(dir, ["update-ref", "refs/pull/8/head", head]);
  return {root: join(dir, "cache"), remote: dir, base, head};
}

function localTransport(remote: string, fetches: string[], rejectHead?: string): Execute {
  return async (dir, args, vars) => {
    assert.ok(!JSON.stringify(args).includes(token));
    assert.equal(vars.GIT_CONFIG_GLOBAL, "/dev/null");
    assert.ok(args.includes("core.hooksPath=/dev/null"));
    assert.equal(vars.GIT_ALLOW_PROTOCOL, "https");
    if (!args.includes("fetch")) {
      assert.equal(vars.GIT_CONFIG_VALUE_0, undefined);
      return git(dir, args, vars);
    }
    assert.equal(args.at(-2), url);
    assert.equal(vars.GIT_CONFIG_KEY_0, "http." + url + ".extraHeader");
    assert.equal(vars.GIT_CONFIG_VALUE_0, "Authorization: Basic " + Buffer.from("x-access-token:" + token).toString("base64"));
    assert.ok(args.includes("http.followRedirects=false"));
    const ref = args.at(-1)!;
    fetches.push(ref);
    if (ref === rejectHead) throw new Error("Unadvertised object");
    // The synthetic origin differs only at the transport boundary. Git writes
    // real object packs, and production never invokes the file protocol.
    return git(dir, [...args.slice(0, -2), remote, ref], {...env, GIT_ALLOW_PROTOCOL: "file"});
  };
}

test("a bare cache pins exact history, reuses it and isolates installations", async t => {
  const {root, remote, base, head} = await fixture(t);
  const refs = {base, head};
  const fetches: string[] = [];
  const transport = localTransport(remote, fetches, head);
  const cache = await prepareCache(root, request, refs, token, signal, transport);
  assert.deepEqual(fetches, [base, head, "refs/pull/8/head"]);
  assert.equal(git(cache, ["rev-parse", "--is-bare-repository"]), "true");
  assert.equal(git(cache, ["rev-parse", "--show-prefix"]), "");
  assert.equal(git(cache, ["show", head + ":source"]), "after");
  assert.equal(git(cache, ["rev-parse", "refs/perry/commits/" + base]), base);
  assert.equal(git(cache, ["remote"]), "");
  assert.ok(!(await readFile(join(cache, "config"), "utf8")).includes(token));
  assert.ok(!(await readdir(cache)).includes("FETCH_HEAD"));
  // The real Git subprocess must serve a warmed request without ever reaching an origin.
  assert.equal(await prepareCache(root, request, refs, token, signal), cache);
  const separate = await prepareCache(root, {...request, installationId: "22"}, refs, token, signal, transport);
  assert.notEqual(separate, cache);
  assert.equal(fetches.length, 6);
});

test("concurrent initialization leaves one complete Git store and no scratch directories", async t => {
  const {root, remote, base, head} = await fixture(t);
  const calls = Array.from({length: 3}, () => prepareCache(root, request, {base, head}, token, signal, localTransport(remote, [])));
  const results = await Promise.all(calls);
  assert.equal(new Set(results).size, 1);
  assert.deepEqual(await readdir(join(root, "12")), ["34.git"]);
  assert.equal(git(results[0]!, ["rev-parse", "refs/perry/commits/" + head]), head);
});

test("a moved pull ref cannot substitute another commit and questions never fetch PR refs", async t => {
  const {root, remote, base} = await fixture(t);
  const head = "f".repeat(40);
  const calls: string[] = [];
  await assert.rejects(prepareCache(root, request, {base, head}, token, signal, localTransport(remote, calls, head)), /pinned commit/);
  assert.ok(calls.includes("refs/pull/8/head"));
  calls.length = 0;
  await assert.rejects(prepareCache(root, {...request, isPR: false}, {base, head}, token, signal, localTransport(remote, calls, head)));
  assert.deepEqual(calls, [head]);
});

test("invalid scope, cancellation and altered Git configuration stop before network access", async t => {
  const {root, remote, base, head} = await fixture(t);
  const refs = {base, head};
  const transport = localTransport(remote, []);
  await assert.rejects(prepareCache(root, {...request, repoId: "../34"}, refs, token, signal), /scope/);
  await assert.rejects(prepareCache(root, {...request, owner: "example.invalid@elsewhere"}, refs, token, signal), /scope/);
  await assert.rejects(prepareCache(root, request, {base: "HEAD", head}, token, signal), /scope/);
  await assert.rejects(prepareCache(root, request, refs, token, AbortSignal.abort()));
  const cache = await prepareCache(root, request, refs, token, signal, transport);
  await appendFile(join(cache, "config"), "[remote \"origin\"]\n\turl = ignored\n");
  await assert.rejects(prepareCache(root, request, refs, token, signal), /configuration/);
});
