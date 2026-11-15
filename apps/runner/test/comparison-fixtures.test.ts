import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { comparisons } from "../../../tools/fixtures/comparisons.ts";
import { comparisonExpectations as cases } from "../../../tools/fixtures/expectations.ts";

const fixture = fileURLToPath(new URL("../../../tools/fixtures/review.ts", import.meta.url));

test("every starter comparison has one expectation outside the reviewed repository", () => {
  assert.ok(cases.length >= 20);
  assert.deepEqual(cases.map(item => item.name).sort(), Object.keys(comparisons).sort());
});

for (const { name, finding, location, knownMiss, limitation } of cases) {
  test("Git comparison: " + name, () => {
    const output = execFileSync(process.execPath, [fixture, name], {
      encoding: "utf8", timeout: 60_000, windowsHide: true,
    });
    const [summary, bugs] = output.split("\n\n---\n\n");
    assert.match(summary!, /^## Perry review/);
    assert.match(bugs!, /^## Bugs and suggested fixes/);
    const head = /Head `([a-f0-9]{40,64})`/.exec(summary!)?.[1];
    assert.ok(head);
    assert.match(summary!, /\| (?:10|[0-9])\/10 merge readiness/);
    const findings = bugs!.match(/^\d+\. \*\*\w+\*\* .+$/gm) ?? [];
    if (finding || (knownMiss && findings.length)) {
      assert.equal(findings.length, 1, bugs);
      assert.match(bugs!, finding ?? knownMiss!);
      if (location) assert.ok(bugs!.includes("`" + location + "` at `" + head + "`"), bugs);
      assert.match(summary!, /DO NOT MERGE/);
    } else {
      assert.equal(findings.length, 0, bugs);
      assert.match(summary!, /HOLD/);
      assert.match(bugs!, /Limitations/);
    }
    if (limitation) assert.match(bugs!, limitation);
  });
}
