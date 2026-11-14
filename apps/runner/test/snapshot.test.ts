import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { openSnapshot } from "../src/snapshot.ts";

function repository(t: TestContext) {
  const parent = resolve(tmpdir());
  const dir = mkdtempSync(join(parent, "perry-snapshot-"));
  t.after(() => {
    assert.equal(dirname(dir), parent);
    rmSync(dir, { recursive: true, force: true });
  });
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], {
    env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    },
    encoding: "utf8", windowsHide: true,
  }).trim();
  git("init", "-q", "--template=", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "core.autocrlf", "false");
  const put = (path: string, body: string | Buffer) => writeFileSync(join(dir, path), body);
  const commit = (message: string) => {
    git("commit", "-qm", message);
    return git("rev-parse", "HEAD");
  };
  put("name with spaces", "at fork\n");
  git("add", ".");
  const fork = commit("create initial snapshot");
  return { dir, git, put, commit, fork };
}

test("a diverged base and a dirty tree do not change the PR snapshot", async t => {
  const { dir, git, put, commit, fork } = repository(t);
  put("only on base", "base\n");
  git("add", ".");
  const base = commit("advance target branch");
  git("switch", "-qc", "topic", fork);
  put("name with spaces", "at head\n");
  git("add", ".");
  const head = commit("modify source file");
  const snapshot = await openSnapshot(dir, base, head);
  git("switch", "-q", "main");
  put("name with spaces", "dirty\n");
  assert.equal(snapshot.merge_base, fork);
  assert.deepEqual(snapshot.changes, [{ path: "name with spaces", status: "modified" }]);
  assert.deepEqual(await snapshot.read("head", "name with spaces"), { kind: "text", text: "at head\n" });
  assert.deepEqual(await snapshot.read("merge_base", "name with spaces"), { kind: "text", text: "at fork\n" });
  assert.deepEqual(await snapshot.read("base", "only on base"), { kind: "text", text: "base\n" });
  assert.deepEqual(await snapshot.read("head", "only on base"), { kind: "missing" });
  assert.deepEqual(await snapshot.read("head", "*"), { kind: "missing" });
});

test("renames have independently readable old and new paths", async t => {
  const { dir, git, commit, fork } = repository(t);
  git("mv", "name with spaces", "new name");
  const snapshot = await openSnapshot(dir, fork, commit("rename source file"));
  assert.deepEqual(snapshot.changes, [
    { path: "name with spaces", status: "deleted" },
    { path: "new name", status: "added", previousPath: "name with spaces" },
  ]);
  assert.deepEqual(await snapshot.read("head", "name with spaces"), { kind: "missing" });
  assert.deepEqual(await snapshot.read("head", "new name"), { kind: "text", text: "at fork\n" });
});

test("only regular bounded UTF-8 text is returned", async t => {
  const { dir, put, git, fork, commit } = repository(t);
  put("binary", Buffer.from([0x41, 0, 0x42]));
  put("invalid", Buffer.from([0xff, 0x42]));
  put("oversized", Buffer.alloc(1024 * 1024 + 1, 0x41));
  git("add", ".");
  const oid = git("rev-parse", fork + ":name with spaces");
  git("update-index", "--add", "--cacheinfo", "120000," + oid + ",link");
  git("update-index", "--add", "--cacheinfo", "160000," + fork + ",module");
  const snapshot = await openSnapshot(dir, fork, commit("add fixture entries"));
  assert.ok(snapshot.changes.some(change => change.path === "module"));
  for (const path of ["link", "module", "binary", "invalid", "oversized", "../file", "/etc/hosts", ".git/config", "a\\b", "a\nb"]) {
    assert.equal((await snapshot.read("head", path)).kind, "unavailable", path);
  }
});

test("selected commits must exist as full local commit objects", async t => {
  const { dir, git, fork } = repository(t);
  git("tag", "-a", "sample", "-m", "fixture tag");
  for (const id of ["HEAD", fork.slice(0, 12), "0".repeat(40), git("rev-parse", "sample"), git("rev-parse", "HEAD^{tree}")]) {
    await assert.rejects(openSnapshot(dir, fork, id), /commit IDs/);
  }
  assert.deepEqual((await openSnapshot(dir, fork, fork)).changes, []);
});

test("multiple merge bases are reported as ambiguous", async t => {
  const { dir, git, fork } = repository(t);
  const tree = git("rev-parse", fork + "^{tree}");
  const left = git("commit-tree", tree, "-p", fork, "-m", "left parent");
  const right = git("commit-tree", tree, "-p", fork, "-m", "right parent");
  const base = git("commit-tree", tree, "-p", left, "-p", right, "-m", "merge left first");
  const head = git("commit-tree", tree, "-p", right, "-p", left, "-m", "merge right first");
  await assert.rejects(openSnapshot(dir, base, head), /one locally available merge base/);
});

test("a shallow graph cannot establish a complete merge base", async t => {
  const { dir, put, git, fork, commit } = repository(t);
  put("new file", "content\n");
  git("add", ".");
  const head = commit("add changed file");
  put(".git/shallow", head + "\n");
  await assert.rejects(openSnapshot(dir, fork, head), /full local history/);
});
