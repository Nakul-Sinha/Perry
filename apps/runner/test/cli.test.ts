import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(new URL("../../../tools/fixtures/review.ts", import.meta.url));
const cli = fileURLToPath(new URL("../src/index.ts", import.meta.url));

for (const scenario of ["broken", "clean", "unsupported", "missing"]) {
  test("local review command: " + scenario, () => {
    const proc = spawnSync(process.execPath, [fixture, scenario], { encoding: "utf8", windowsHide: true });
    assert.equal(proc.status, scenario === "missing" ? 1 : 0, proc.stderr || proc.stdout);
    assert.equal(proc.stdout.match(/^## /gm)?.length, 2);
    assert.match(proc.stdout, /^## Perry review/m);
    assert.match(proc.stdout, /^## Bugs and suggested fixes/m);
    if (scenario === "broken") {
      assert.match(proc.stdout, /DO NOT MERGE \| 4\/10/);
      assert.match(proc.stdout, /Missing npm script lint/);
      assert.match(proc.stdout, /Module fails to parse/);
      assert.match(proc.stdout, /package\.json:4/);
      assert.match(proc.stdout, /index\.mjs:1/);
      assert.match(proc.stdout, /consumer\.mjs:1/);
      assert.match(proc.stdout, /subtotal/);
    } else if (scenario === "clean") {
      assert.match(proc.stdout, /HOLD \| 4\/10/);
      assert.match(proc.stdout, /No verified bugs found within the reviewed scope/);
    } else if (scenario === "unsupported") {
      assert.match(proc.stdout, /HOLD \| 0\/10/);
      assert.match(proc.stdout, /design\.md/);
    } else {
      assert.match(proc.stdout, /HOLD \| 0\/10/);
      assert.match(proc.stdout, /both full commit IDs/);
    }
  });
}

test("invalid arguments explain the CLI and exit with a usage error", () => {
  const proc = spawnSync(process.execPath, [cli, "review", "--repo", "."], { encoding: "utf8" });
  assert.equal(proc.status, 2);
  assert.match(proc.stderr, /--base.*--head/);
});
