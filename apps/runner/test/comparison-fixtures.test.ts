import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { comparisons } from "../../../tools/fixtures/comparisons.ts";

const fixture = fileURLToPath(new URL("../../../tools/fixtures/review.ts", import.meta.url));

// These labels are held outside the Git inputs. A known miss records a real
// defect that the static preview may abstain on. A later correct finding is
// acceptable; a claim about a different cause is not.
const cases = [
  { name: "script-rename" },
  { name: "script-removed", finding: /Missing npm script lint/, location: "package.json:4" },
  { name: "script-optional", limitation: /npm configuration/ },
  { name: "script-existing" },
  { name: "script-shared-target", finding: /Missing npm script lint/, location: "package.json:4" },
  { name: "manifest-punctuation", finding: /Invalid package manifest JSON/, location: "package.json:3" },
  { name: "manifest-metadata" },
  { name: "manifest-move" },
  { name: "module-declaration", finding: /Module fails to parse/, location: "total.mjs:1" },
  { name: "module-expression" },
  { name: "module-existing" },
  { name: "import-binding", finding: /Missing named export: balance/, location: "invoice.mjs:1" },
  { name: "import-alias" },
  { name: "unchanged-consumer", finding: /Missing named export: total/, location: "invoice.mjs:1" },
  { name: "compatible-export" },
  { name: "forwarded-binding", limitation: /outside the supported source syntax/ },
  { name: "empty-cart", knownMiss: /empty.*(?:cart|array|reduce)|reduce.*(?:initial|empty)/i },
  { name: "cart-refactor" },
  { name: "module-binary", limitation: /source is unavailable/i },
  { name: "package-deleted", limitation: /Impact of removing this package/ },
];

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
