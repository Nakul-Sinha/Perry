import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { runSandboxCheck } from "../../apps/runner/src/sandbox.ts";

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
  assert.equal(result.status, check.status, result.detail);
  assert.equal(containers(), "", "Podman retained a container after " + check.status);
  console.log(check.status + " verified, container disposed");
}
