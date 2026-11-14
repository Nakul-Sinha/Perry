import assert from "node:assert/strict";
import test from "node:test";
import type { Finding, ReportInput, Severity } from "../src/contracts.ts";
import { renderReport } from "../src/report.ts";

const head = "1".repeat(40);
const base = "2".repeat(40);

function reviewed(): ReportInput {
  return {
    snapshot: { base, head, merge_base: base },
    inspection: {
      changes: ["Updated the build script."],
      findings: [],
      coverage: [{ path: "package.json", disposition: "checked", reason: "Inspected scripts." }],
      limitations: [],
    },
    assessment: "completed",
    readiness: {
      freshness: "current", mergeability: "clean", checks: "passed",
      prerequisites: "satisfied", unresolvedMaterialRisk: false,
    },
  };
}

function finding(id: string, severity: Severity): Finding {
  return {
    id, severity, title: `Broken ${id}`, trigger: "Run the package script.",
    impact: "The build exits.", fix: "Restore the target.",
    evidence: { sha: head, path: "packages/app/package.json", line: 14 },
  };
}

test("a fresh clean assessment produces independent summary and findings bodies", () => {
  const result = renderReport(reviewed());
  assert.equal(result.score, 10);
  assert.equal(result.recommendation, "MERGE");
  assert.match(result.summary, /10\/10 merge readiness/);
  assert.match(result.summary, /Updated the build script/);
  assert.match(result.summary, /1\/1 changed paths checked/);
  assert.match(result.findings, /No verified bugs found within the reviewed scope/);
  for (const body of [result.summary, result.findings]) assert.ok(body.includes(head));
});

test("severity caps and deductions apply once for each root cause", () => {
  for (const [severity, expected] of Object.entries({ critical: 3, high: 5, medium: 7, low: 9 })) {
    const input = reviewed();
    const issue = finding("one", severity as Severity);
    input.inspection.findings = [finding("one", "low"), issue, issue];
    const report = renderReport(input);
    assert.equal(report.score, expected);
    assert.equal(report.recommendation, severity === "low" ? "MERGE" : "DO NOT MERGE");
    assert.equal(report.findings.split("Broken one").length - 1, 1);
    assert.ok(report.findings.includes("packages/app/package.json:14"));
    assert.ok(report.findings.includes("Static evidence"));
    assert.ok(report.findings.includes("Suggested fix (untested)"));
  }
  const input = reviewed();
  input.inspection.findings = Array.from({ length: 7 }, (_, index) => finding(String(index), "high"));
  const report = renderReport(input);
  assert.equal(report.score, 0);
  assert.match(report.findings, /Broken 6/);
});

test("GitHub blockers win over incomplete coverage; unknown prerequisites hold", () => {
  const input = reviewed();
  input.readiness.checks = "unknown";
  input.readiness.freshness = "unknown";
  input.readiness.mergeability = "unknown";
  input.readiness.prerequisites = "unknown";
  const unknown = renderReport(input);
  assert.equal(unknown.recommendation, "HOLD");
  assert.equal(unknown.score, 7);
  assert.match(unknown.summary, /GitHub mergeability unknown/);
  assert.match(unknown.summary, /required checks unknown/);
  input.inspection.coverage.push({ path: "src/unread.ts", disposition: "incomplete", reason: "Unsupported stack" });
  const incomplete = renderReport(input);
  assert.equal(incomplete.score, 4);
  assert.match(incomplete.summary, /provisional/);
  assert.match(incomplete.findings, /Coverage is partial/);
  assert.ok(incomplete.findings.includes("`src/unread.ts`: Unsupported stack"));
  input.readiness.mergeability = "conflicts";
  assert.equal(renderReport(input).recommendation, "DO NOT MERGE");
  input.readiness.mergeability = "clean";
  input.readiness.checks = "failed";
  assert.equal(renderReport(input).recommendation, "DO NOT MERGE");
  input.readiness.checks = "passed";
  input.inspection.findings = [finding("blocker", "medium")];
  assert.equal(renderReport(input).recommendation, "DO NOT MERGE");
  assert.equal(renderReport(input).score, 4);
});

test("failed, canceled, stale and unassessed observations are provisional in both bodies", () => {
  for (const assessment of ["failed", "canceled", "stale", "unassessed"] as const) {
    const input = reviewed();
    input.assessment = assessment;
    input.inspection.limitations.push("Input unavailable");
    input.readiness.checks = "failed";
    const result = renderReport(input);
    assert.equal(result.score, 0);
    assert.equal(result.recommendation, "HOLD");
    assert.match(result.summary, /provisional/);
    assert.match(result.summary, /Input unavailable/);
    assert.match(result.findings, /No current bug assessment/);
    assert.doesNotMatch(result.findings, /No verified bugs found/);
  }
  const input = reviewed();
  input.readiness.freshness = "stale";
  assert.equal(renderReport(input).score, 0);
  input.readiness.freshness = "current";
  input.snapshot = null;
  assert.equal(renderReport(input).score, 0);
});

test("unresolved risk, pending checks and unmet prerequisites independently hold a clean PR", () => {
  const input = reviewed();
  input.readiness.checks = "not_required";
  assert.equal(renderReport(input).recommendation, "MERGE");
  input.readiness.checks = "pending";
  assert.equal(renderReport(input).score, 7);
  assert.equal(renderReport(input).recommendation, "HOLD");
  input.readiness.checks = "passed";
  input.readiness.prerequisites = "unsatisfied";
  assert.equal(renderReport(input).score, 7);
  assert.equal(renderReport(input).recommendation, "HOLD");
  input.readiness.prerequisites = "satisfied";
  input.readiness.unresolvedMaterialRisk = true;
  const report = renderReport(input);
  assert.equal(report.score, 4);
  assert.equal(report.recommendation, "HOLD");
});

test("repository text is literal inline code and cannot create its own Markdown blocks", () => {
  const input = reviewed();
  const text = "@team\n\n## fake\n`escape` [link](https://example.org) <img> ``";
  input.inspection.changes = [text];
  input.inspection.findings = [{ ...finding("bad", "medium"), fix: text }];
  input.inspection.limitations = [text];
  const report = renderReport(input);
  for (const body of [report.summary, report.findings]) {
    assert.ok(body.includes("``` @team ## fake `escape` [link](https://example.org) <img> `` ```"));
    assert.doesNotMatch(body, /^## fake/m);
  }
});
