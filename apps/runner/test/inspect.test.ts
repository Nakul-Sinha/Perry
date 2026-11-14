import assert from "node:assert/strict";
import test from "node:test";
import type { BlobRead, Snapshot } from "../src/contracts.ts";
import { inspect } from "../src/inspect.ts";

const path = "apps/web/package.json";
const headSha = "f".repeat(40);
const ancestorSha = "a".repeat(40);
const manifest = (scripts: Record<string, unknown>) => JSON.stringify({ scripts }, null, 2);
const blob = (text: string): BlobRead => ({ kind: "text", text });

function snapshot(
  base: BlobRead, head: BlobRead, status: Snapshot["changes"][number]["status"] = "modified", previousPath?: string,
): Snapshot {
  return {
    base: "b".repeat(40), head: headSha, merge_base: ancestorSha,
    changes: [previousPath ? { path, status, previousPath } : { path, status }],
    async read(ref, requested) {
      if (requested.endsWith(".npmrc")) {
        assert.equal(ref, "head");
        return { kind: "missing" };
      }
      assert.equal(requested, ref === "merge_base" ? previousPath ?? path : path);
      assert.notEqual(ref, "base", "Use the common ancestor even when the target branch has advanced.");
      return ref === "head" ? head : base;
    },
  };
}

test("a removed script breaks an unchanged caller at its head line", async () => {
  const result = await inspect(snapshot(
    blob(manifest({ build: "npm run compile", compile: "tsc" })), blob(manifest({ build: "npm run compile" })),
  ));
  assert.equal(result.findings.length, 1);
  const finding = result.findings[0]!;
  assert.deepEqual(finding.evidence, { sha: headSha, path, line: 3 });
  assert.match(finding.trigger, /npm run build/);
  assert.match(finding.fix, /compile/);
  assert.equal(finding.severity, "medium");
  assert.match(result.changes.join(" "), /removed compile/);
  assert.equal(result.coverage[0]?.disposition, "checked");
});

test("new and edited callers can introduce a missing target in existing or added packages", async () => {
  for (const old of [manifest({}), manifest({ build: "npm run old", old: "tsc" }), undefined]) {
    const result = await inspect(snapshot(
      old ? blob(old) : { kind: "missing" }, blob(manifest({ build: "npm run types:check" })), old ? "modified" : "added",
    ));
    assert.equal(result.findings.length, 1);
    assert.match(result.findings[0]!.title, /types:check/);
  }
});

test("several callers of one removed script produce one root cause", async () => {
  const callers = { build: "npm run types", test: "npm run types" };
  const result = await inspect(snapshot(blob(manifest({ ...callers, types: "tsc" })), blob(manifest(callers))));
  assert.equal(result.findings.length, 1);
});

test("equivalent prior npm invocations cannot introduce an existing missing target", async () => {
  const after = blob(manifest({ check: "npm run lint" }));
  for (const previous of ["npm run-script lint", 'npm run "lint"', "npm run lint --"]) {
    const broken = await inspect(snapshot(blob(manifest({ check: previous })), after));
    assert.deepEqual(broken.findings, []);
    const working = await inspect(snapshot(blob(manifest({ check: previous, lint: "tsc" })), after));
    assert.equal(working.findings.length, 1);
  }
});

test("pre-existing defects and valid peers stay quiet", async () => {
  for (const [before, after] of [
    [{ ch: "npm run absent" }, { ch: " npm  run absent ", ok: "echo ok" }],
    [{}, { ch: "npm run lint", lint: "eslint ." }],
    [{}, { ch: "npm run lint || echo skipped" }],
    [{}, { ch: "npm run --if-present lint" }],
    [{}, { ch: "npm run lint --if-present" }],
    [{}, { ch: "npm run lint -w other" }],
    [{}, { ch: "npm run lint", prech: "node generate-manifest.mjs" }],
    [{}, { ch: "npm run env", api: "npm run start", app: "npm run restart", lib: "npm run install" }],
    [{}, { ch: "npm run echo\nnode foo" }],
    [{}, { ch: "npm run lint", lint: "" }],
  ] as [Record<string, unknown>, Record<string, unknown>][]) {
    const result = await inspect(snapshot(blob(manifest(before)), blob(manifest(after))));
    assert.equal(result.findings.length, 0, JSON.stringify(after));
  }
});

test("source line uses the effective escaped key, even with nested distractors and duplicate keys", async () => {
  const lines = [
    '{ "scripts": { "check": "npm run missing" },',
    '  "other": { "check": "npm run missing" },',
    '  "scr\\u0069pts": { "check": "npm run obsolete",',
    '    "ch\\u0065ck": "npm run missing" },',
    '  "more": [{"check": "npm run missing"}] }',
  ];
  const result = await inspect(snapshot(blob("{}"), blob(lines.join("\r\n"))));
  assert.equal(result.findings.length, 1);
  assert.deepEqual(result.findings[0]!.evidence, { sha: headSha, path, line: 4 });
});

test("project or workspace npm configuration can invalidate default missing-script behavior", async () => {
  for (const directory of [".npmrc", "apps/.npmrc", "apps/web/.npmrc"]) {
    const input = snapshot(blob("{}"), blob(manifest({ build: "npm run optional" })));
    const read = input.read;
    input.read = async (ref, file) => file === directory ? blob("if-present=true") : read(ref, file);
    const result = await inspect(input);
    assert.equal(result.findings.length, 0);
    assert.match(result.coverage[0]!.reason, /configuration/);
  }
  const comments = snapshot(blob("{}"), blob(manifest({ build: "npm run absent" })));
  const read = comments.read;
  comments.read = async (ref, file) => file === ".npmrc" ? blob(" # Optional scripts\n; if-present=true") : read(ref, file);
  assert.equal((await inspect(comments)).findings.length, 1);
});

test("new malformed syntax receives a pinned citation and a diagnostic for skipped checks", async () => {
  const damaged = '{\n  "private": true,\n}\n';
  for (const status of ["modified", "added"] as const) {
    const result = await inspect(snapshot(blob("{}"), blob(damaged), status));
    assert.equal(result.findings[0]?.severity, "high");
    assert.deepEqual(result.findings[0]?.evidence, { sha: headSha, path, line: 3 });
    assert.equal(result.coverage[0]?.disposition, "incomplete");
  }
});

test("late JSON token errors without a parser offset are reported as a gap", async () => {
  const damaged = '{\n  "private": true,\n  "scripts": {},\n  "name": undefined\n}';
  const result = await inspect(snapshot(blob("{}"), blob(damaged)));
  assert.equal(result.findings.length, 0);
  assert.equal(result.coverage[0]?.disposition, "incomplete");
  assert.match(result.coverage[0]!.reason, /invalid JSON/);
});

test("a manifest move preserves an existing parse error or missing npm target", async () => {
  for (const src of ['{\n "private":true,\n}', manifest({ build: "npm run absent" })]) {
    const result = await inspect(snapshot(blob(src), blob(src), "added", "old/package.json"));
    assert.equal(result.findings.length, 0);
    assert.match(result.changes[0]!, /Moved old\/package\.json/);
  }
  const result = await inspect(snapshot(blob("{}"), blob(manifest({ build: "npm run absent" })), "added", "old/package.json"));
  assert.deepEqual(result.findings[0]?.evidence, { sha: headSha, path, line: 3 });
});

test("a move from a different basename leaves manifest regression attribution open", async () => {
  const result = await inspect(snapshot(blob("{}"), blob(manifest({ build: "npm run absent" })), "added", "template.json"));
  assert.equal(result.findings.length, 0);
  assert.equal(result.coverage[0]?.disposition, "incomplete");
});

test("preserves legacy invalid JSON, unsupported blob and missing evidence as coverage gaps", async () => {
  for (const [base, head] of [
    [blob("{"), blob("{")], [blob("{}"), {kind: "unavailable", reason: "Not a regular file."}],
    [{kind: "missing"}, blob(manifest({ check: "npm run x" }))], [blob("{}"), blob("[]")],
  ] as [BlobRead, BlobRead][]) {
    const result = await inspect(snapshot(base, head));
    assert.equal(result.findings.length, 0);
    assert.equal(result.coverage[0]?.disposition, "incomplete");
  }
});

test("handles a leading BOM and avoids inventing a line for an empty blob", async () => {
  const clean = await inspect(snapshot(blob("{}"), blob("\uFEFF" + manifest({ ok: "true" }))));
  assert.equal(clean.findings.length, 0);
  const removed = await inspect(snapshot(blob("{}"), blob("")));
  assert.equal(removed.findings.length, 0);
  assert.equal(removed.coverage[0]?.disposition, "incomplete");
  const empty = await inspect(snapshot({ kind: "missing" }, blob(""), "added"));
  assert.equal(empty.findings.length, 0);
  assert.equal(empty.coverage[0]?.disposition, "incomplete");
});

test("account for deleted manifests and other changed files without reading them", async () => {
  const input = snapshot(blob("{}"), blob("{}"));
  input.changes = [{ path, status: "deleted" }, { path: "app.js", status: "added" }];
  input.read = async () => { throw new Error("No blob inspection expected."); };
  const result = await inspect(input);
  assert.equal(result.coverage.length, 2);
  assert.ok(result.coverage.every(entry => entry.disposition === "incomplete"));
  assert.deepEqual(result.changes, [`Deleted ${path}.`, "Added app.js."]);
});

test("budgeted files and scripts stay in coverage, even when the summary is condensed", async () => {
  const input = snapshot(blob("{}"), blob("{}"));
  input.changes = Array.from({ length: 34 }, (_, i) => ({ path: `packages/p${i}/package.json`, status: "added" }));
  let reads = 0;
  input.read = async () => { reads++; return blob("{}"); };
  const result = await inspect(input);
  assert.equal(reads, 32);
  assert.equal(result.coverage.length, input.changes.length);
  assert.equal(result.coverage.at(-1)?.disposition, "incomplete");
  assert.equal(result.changes.length, 6);
  const manyScripts = Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`compile${i}`, "tsc"]));
  const skipped = await inspect(snapshot(blob("{}"), blob(manifest(manyScripts))));
  assert.equal(skipped.coverage[0]?.disposition, "incomplete");
});
