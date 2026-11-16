import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { runPairCommand } from "../src/pair-cli.ts";

const key = () => randomBytes(32).toString("base64url");
const posix = {skip:process.platform === "win32"};

async function setup(t: TestContext) {
  const dir = await mkdtemp(join(await realpath(tmpdir()), "perry-pair-test-"));
  t.after(() => rm(dir,{recursive:true, force:true}));
  const codePath = join(dir,"code");
  const path = join(dir,"identity");
  const code = key();
  await writeFile(codePath,code + "\n",{mode:0o600});
  const origin = "http://127.0.0.1:4258";
  const args = ["pair","--server",origin,"--identity",path,"--code-file",codePath];
  const status = ["pair-status","--identity",path];
  const ids = {runnerId:randomUUID(), installationId:"101",repoId:"202"};
  const token = key();
  return {dir,codePath,path,code,origin,args,status,ids,token};
}

test("rejects ambiguous, remote HTTP and non-origin URLs before sending credentials", async t => {
  const send = t.mock.method(globalThis,"fetch",async () => assert.fail("Unexpected HTTP request"));
  for (const origin of ["http://example.org","http://127.1","http://127.0.0.1:3/path","https://example.org/?",
    "https://user@example.org","https://example.org/#fragment","https://example.org\\"," https://example.org"]) {
    await assert.rejects(runPairCommand(["pair","--server",origin,"--identity","unused","--code-file","unused"]),/origin/);
  }
  await assert.rejects(runPairCommand(["pair-status","--identity","one","--identity","two"]),/Use pair/);
  assert.equal(send.mock.callCount(),0);
});

test("native Windows declines enrollment before reading or sending credentials", {skip:process.platform !== "win32"},async t => {
  const send = t.mock.method(globalThis,"fetch",async () => assert.fail("Unexpected HTTP request"));
  await assert.rejects(runPairCommand(["pair","--server","http://127.0.0.1","--identity","unused","--code-file","unused"]), /WSL/);
  assert.equal(send.mock.callCount(),0);
});

test("enrolls once into a private file and verifies the same identity and scope on status", posix, async t => {
  const f = await setup(t);
  const log = t.mock.method(console,"log",() => {});
  const calls = t.mock.method(globalThis,"fetch",async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input,init);
    assert.equal(req.redirect,"error");
    if (req.url === f.origin + "/runners/pair") {
      assert.equal(req.method,"POST");
      assert.deepEqual(await req.json(),{code:f.code});
      assert.equal(req.headers.get("authorization"),null);
      return Response.json({...f.ids,token:f.token});
    }
    assert.equal(req.url,f.origin + "/runners/me");
    assert.equal(req.method,"GET");
    assert.equal(req.headers.get("authorization"),"Bearer " + f.token);
    return Response.json(f.ids);
  });
  await runPairCommand(f.args);
  assert.equal((await lstat(f.path)).mode & 0o777,0o600);
  assert.deepEqual(JSON.parse(await readFile(f.path,"utf8")),{...f.ids,origin:f.origin,token:f.token});
  await runPairCommand(f.status);
  await assert.rejects(runPairCommand([...f.status,"--server","https://other.example"]),/differs/);
  await assert.rejects(runPairCommand(f.args),/unused identity/);
  const output = log.mock.calls.flatMap(call => call.arguments).join(" ");
  assert.ok(output.includes(f.ids.runnerId) && !output.includes(f.code) && !output.includes(f.token));
  assert.equal(calls.mock.callCount(),2);
});

test("unsafe permissions, hard links, symlinks and malformed codes leave the server untouched", posix,async t => {
  const f = await setup(t);
  const calls = t.mock.method(globalThis,"fetch",async () => assert.fail("Unexpected HTTP request"));
  await chmod(f.codePath,0o640);
  await assert.rejects(runPairCommand(f.args),/owner-only/);
  await chmod(f.codePath,0o600);
  const alias = join(f.dir,"linked");
  await link(f.codePath,alias);
  await assert.rejects(runPairCommand(f.args),/owner-only/);
  await rm(alias);
  await symlink(f.codePath,alias);
  await assert.rejects(runPairCommand([...f.args.slice(0,-1),alias]),/owner-only/);
  await symlink(f.codePath,f.path);
  await assert.rejects(runPairCommand(f.args),/unused identity/);
  await rm(f.path);
  for (const content of [" " + f.code,f.code + "\n\n",f.code + "x"]) {
    await writeFile(f.codePath,content);
    await assert.rejects(runPairCommand(f.args),/invalid format/);
  }
  assert.equal(calls.mock.callCount(),0);
});

test("HTTP or schema failures clear the reserved path and redact enrollment errors",posix,async t => {
  const f = await setup(t);
  const secret = key();
  for (const response of [
    Response.json({error:secret},{status:403}),Response.json({...f.ids,token:"short"}),
    new Response(" ".repeat(5000),{headers:{"Content-Type":"application/json"}}),Response.json({runnerId:secret,token:f.token}),
  ]) {
    const calls = t.mock.method(globalThis,"fetch",async () => response);
    await assert.rejects(runPairCommand(f.args),error => error instanceof Error && !error.message.includes(secret) && !error.message.includes(f.code));
    await assert.rejects(lstat(f.path),{code:"ENOENT"});
    assert.equal(calls.mock.callCount(),1);
    calls.mock.restore();
  }
});

test("status rejects a mismatched returned repository and tampered origin",posix,async t => {
  const f = await setup(t);
  const calls = t.mock.method(globalThis,"fetch",async () => Response.json({...f.ids,repoId:"999"}));
  await writeFile(f.path,JSON.stringify({...f.ids,token:f.token,origin:f.origin}),{mode:0o600});
  await assert.rejects(runPairCommand(f.status),/different runner or repository/);
  await writeFile(f.path,JSON.stringify({...f.ids,token:f.token,origin:"http://remote.example"}));
  await assert.rejects(runPairCommand(f.status),/origin/);
  assert.equal(calls.mock.callCount(),1);
});
