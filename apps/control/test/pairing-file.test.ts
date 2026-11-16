import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { issueCodeFile, PairingFileError } from "../src/pairing.ts";

const scope = {installationId: "101", repoId: "202"};

test("issuance gives native Windows operators a WSL instruction", {skip: process.platform !== "win32"}, async () => {
  await assert.rejects(issueCodeFile({issue: async () => assert.fail()}, scope, "unused"), error =>
    error instanceof PairingFileError && error.message.includes("WSL"));
});

test("private issuance rejects writable ancestors, then permits retry after a database failure", {skip: process.platform === "win32"}, async t => {
  const dir = await mkdtemp(join(await realpath(tmpdir()), "perry-issue-test-"));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const parent = join(dir, "private");
  const path = join(parent, "pair-code");
  await mkdir(parent, {mode: 0o700});
  const alias = join(dir, "alias");
  await symlink(parent, alias);
  let calls = 0;
  let failIssue = true;
  const code = randomBytes(32).toString("base64url");
  const store = {issue: async () => {
    calls++;
    if (failIssue) throw new Error(code);
    return {code, expiresAt: new Date()};
  }};

  const unsafeDirectory = (error: unknown) => error instanceof PairingFileError && error.message.includes("owner-only");
  await assert.rejects(issueCodeFile(store, scope, join(alias, "pair-code")), unsafeDirectory);
  await chmod(dir, 0o770);
  await assert.rejects(issueCodeFile(store, scope, path), unsafeDirectory);
  assert.equal(calls, 0);

  await chmod(dir, 0o700);
  await assert.rejects(issueCodeFile(store, scope, path), error =>
    error instanceof PairingFileError && error.message.includes("database") && !error.message.includes(code));
  await assert.rejects(lstat(path), {code: "ENOENT"});
  failIssue = false;
  await issueCodeFile(store, scope, path);
  assert.equal((await lstat(path)).mode & 0o777, 0o600);
  assert.ok(await readFile(path, "utf8") === code + "\n");
  await assert.rejects(issueCodeFile(store, scope, path), error =>
    error instanceof PairingFileError && error.message.includes("unused"));
  assert.equal(calls, 2);
});
