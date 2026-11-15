import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkProfile, runSandboxCheck } from "../../apps/runner/src/sandbox.ts";
import { openSnapshot } from "../../apps/runner/src/snapshot.ts";
import { testEvidence, nodeImage } from "../../apps/runner/src/test-evidence.ts";

const image = process.argv[2];
if (!image || process.argv.length !== 3) throw new Error("Usage: node tools/compatibility/sandbox-live.ts <pinned-node-image>");

// Run this on a dedicated runner so other jobs cannot affect the cleanup check.
const containers = () => execFileSync("podman", ["--remote=false", "ps", "--all", "--quiet", "--filter", "name=perry-check-"], {
  encoding: "utf8", timeout: 10000,
}).trim();
assert.equal(containers(), "", "The acceptance runner must start with no Perry check containers.");
process.env.PERRY_HOST_ONLY_CANARY = "fixture";

const resources = `
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
test("approved test sees the isolated Linux profile", () => {
  const read = name => readFileSync(name, "utf8").trim();
  assert.equal(process.env.PERRY_HOST_ONLY_CANARY, undefined);
  assert.equal(process.getuid(), 65534);
  assert.deepEqual(Object.keys(networkInterfaces()).filter(name => name !== "lo"), []);
  assert.equal(read("/sys/fs/cgroup/memory.max"), "268435456");
  assert.equal(read("/sys/fs/cgroup/pids.max"), "48");
  const [quota, period] = read("/sys/fs/cgroup/cpu.max").split(" ").map(Number);
  assert.ok(quota > 0 && quota <= period);
  const mounts = read("/proc/self/mountinfo").split("\\n").map(line => line.split(" "));
  assert.ok(mounts.find(parts => parts[4] === "/")?.[5].split(",").includes("ro"));
  assert.equal(mounts.find(parts => parts[4] === "/tmp")?.includes("tmpfs"), true);
  writeFileSync("/tmp/fixture.txt", "test");
  assert.equal(read("/tmp/fixture.txt"), "test");
});
`;
const cases = [
  { source: resources, status: "passed", timeout: 10000 },
  { source: "import test from 'node:test';test('bad sum', () => { throw Error('fixture'); });", status: "failed", timeout: 10000 },
  { source: "import test from 'node:test';test('deadline', () => new Promise(resolve => setTimeout(resolve, 15000)));", status: "timed_out", timeout: 1500 },
];
for (const check of cases) {
  const result = await runSandboxCheck(check.source, image, check.timeout);
  if (result.status !== check.status && check.source === resources) {
    // Only the fixed compatibility probe can print diagnostics on this runner.
    // The production execution path discards all repository-controlled output.
    const [, ...args] = checkProfile("perry-compat-probe", image, 10000);
    const probe = spawnSync("podman", ["--remote=false", "run", ...args], {
      input: resources, encoding: "utf8", timeout: 15000, maxBuffer: 16384,
    });
    console.error("Compatibility probe", probe.status, probe.stdout, probe.stderr);
  }
  assert.equal(result.status, check.status, result.detail);
  assert.equal(containers(), "", "Podman retained a container after " + check.status);
  console.log(check.status + " verified, container disposed");
}

assert.equal(image, nodeImage);
const [, ...stageArgs] = checkProfile("perry-check-stage-fixture", image, 10000, {
  testPath: "test/cart.test.mjs", modulePath: "src/cart.mjs", moduleSource: "",
});
const stageFailure = spawnSync("podman", ["--remote=false", "run", ...stageArgs], {
  input: "incomplete fixture envelope", timeout: 15000, stdio: ["pipe", "ignore", "ignore"],
});
assert.equal(stageFailure.status, 78, "Staging errors must be distinct from node --test failures.");
assert.equal(containers(), "");
const repo = mkdtempSync(join(tmpdir(), "perry-module-check-"));
try {
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], {encoding: "utf8", env: {
    PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  }}).trim();
  git("init", "--template=", "-q");
  git("config", "user.name", "Perry Fixture");
  git("config", "user.email", "fixture@example.invalid");
  mkdirSync(join(repo, "src"));
  mkdirSync(join(repo, "test"));
  const path = "test/cart.test.mjs";
  const modulePath = "src/cart.mjs";
  writeFileSync(join(repo, path), "import assert from 'node:assert/strict';\nimport {total} from '../src/cart.mjs';\nassert.equal(total([]), 0);\n");
  const revision = (source: string) => {
    writeFileSync(join(repo, modulePath), source);
    git("add", ".");
    git("commit", "-qm", "update cart logic");
    return git("rev-parse", "HEAD");
  };
  const base = revision("export const total = xs => xs.reduce((a,b) => a+b, 0);");
  const head = revision("export const total = xs => xs.reduce((a,b) => a+b);");
  writeFileSync(join(repo, modulePath), "export const total = () => 0;");
  const notes = await testEvidence(await openSnapshot(repo, base, head), path, undefined, modulePath);
  assert.ok(notes.some(note => note.includes(base + ": passed")), notes.join("\n"));
  assert.ok(notes.some(note => note.includes(head + ": failed")), notes.join("\n"));
  assert.equal(containers(), "");
  console.log("Unchanged cart test passed at merge base and failed at head, containers disposed");
} finally { rmSync(repo, {recursive: true, force: true}); }
