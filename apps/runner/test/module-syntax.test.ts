import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import type { BlobRead, Snapshot } from "../src/contracts.ts";
import { inspectModules } from "../src/module-syntax.ts";

const path = "src/sample.mjs";
const oldId = "a".repeat(40);
const newId = "b".repeat(40);
const text = (value: string): BlobRead => ({ kind: "text", text: value });
const absent: BlobRead = { kind: "missing" };
const unreadable: BlobRead = { kind: "unavailable", reason: "Fixture source unavailable." };

function snapshot(before: BlobRead, after: BlobRead, status: Snapshot["changes"][number]["status"]): Snapshot {
  return {
    base: oldId, head: newId, merge_base: oldId, changes: [{ path, status }],
    read: async (revision, name) => {
      assert.equal(name, path);
      assert.ok(revision === "head" || revision === "merge_base");
      return revision === "head" ? after : before;
    },
  };
}

test("new syntax failures have a head-pinned line and a suggested fix", async () => {
  const after = text("const x = 1;\r\nexport default ;\r\n");
  const inputs = [snapshot(text("export default 1;"), after, "modified"), snapshot(absent, after, "added")];
  for (const input of inputs) {
    const result = await inspectModules(input);
    assert.equal(result.coverage[0]?.disposition, "checked");
    assert.equal(result.findings.length, 1);
    const [finding] = result.findings;
    assert.deepEqual(finding!.evidence, { sha: newId, path, line: 2 });
    assert.match(finding!.fix, /syntax/);
    assert.doesNotMatch(JSON.stringify(result), /export default ;/);
  }
});

test("an unclosed construct at EOF cites an existing line", async () => {
  const result = await inspectModules(snapshot(absent, text("export {\n"), "added"));
  assert.equal(result.findings[0]?.evidence.line, 1);
});

test("syntax errors on both revisions are not attributed to the change", async () => {
  const result = await inspectModules(snapshot(text("const ="), text("export default ;"), "modified"));
  assert.equal(result.coverage[0]?.disposition, "checked");
  assert.match(result.coverage[0]!.reason, /both revisions/);
  assert.deepEqual(result.findings, []);
});

test("a broken module moved under a new name retains its old syntax baseline", async () => {
  const broken = text("export const x = ;");
  const input = snapshot(broken, broken, "added");
  input.changes = [{ path, status: "added", previousPath: "src/old.mjs" }];
  input.read = async (ref, file) => {
    assert.equal(file, ref === "head" ? path : "src/old.mjs");
    return broken;
  };
  assert.deepEqual((await inspectModules(input)).findings, []);
});

test("syntax checking does not run top-level code or resolve imports", async t => {
  const parent = resolve(tmpdir());
  const dir = mkdtempSync(join(parent, "perry-syntax-"));
  t.after(() => {
    assert.equal(dirname(dir), parent);
    rmSync(dir, { recursive: true, force: true });
  });
  const marker = join(dir, "evaluated");
  for (const source of [
    "import { writeFileSync } from 'node:fs'; writeFileSync(" + JSON.stringify(marker) + ", 'executed'); throw Error();",
    "import './missing-module.mjs'; throw Error('must not run');",
  ]) {
    const result = await inspectModules(snapshot(absent, text(source), "added"));
    assert.equal(result.coverage[0]?.disposition, "checked");
    assert.deepEqual(result.findings, []);
  }
  assert.equal(existsSync(marker), false);
});

test("missing baselines, deleted files, byte bounds and unrecognized diagnostics leave gaps", async () => {
  const syntaxError = text("export default ;");
  const inputs = [
    snapshot(absent, syntaxError, "modified"),
    snapshot(unreadable, syntaxError, "type_changed"),
    snapshot(text("export default 0;"), syntaxError, "added"),
    snapshot(text("export default 0;"), unreadable, "modified"),
    snapshot(text("export default 0;"), absent, "deleted"),
    snapshot(absent, text(" ".repeat(128 * 1024 + 1)), "added"),
    snapshot(absent, text("const a = 0;\u2028}"), "added"),
  ];
  for (const input of inputs) {
    const result = await inspectModules(input);
    assert.equal(result.coverage[0]?.disposition, "incomplete");
    assert.deepEqual(result.findings, []);
  }
});
