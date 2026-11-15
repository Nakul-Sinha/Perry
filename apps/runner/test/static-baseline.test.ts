import assert from "node:assert/strict";
import { test } from "node:test";
import { assessCase, renderBaseline, summarize } from "../../../tools/evaluation/static-baseline.ts";
import { comparisonExpectations } from "../../../tools/fixtures/expectations.ts";
import type { Finding } from "../src/contracts.ts";
import { renderReport } from "../src/report.ts";

const head = "a".repeat(40);
function finding(id: string, title: string, line = 4): Finding {
  return {id, title, severity: "medium", trigger: "Run the changed check.", impact: "The check fails.",
    fix: "Restore the called script.", evidence: {sha: head, path: "package.json", line}};
}
function report(findings: Finding[] = [], limitations: string[] = []) {
  const bodies = renderReport({
    snapshot: {base: "b".repeat(40), head, merge_base: "b".repeat(40)},
    assessment: "partial",
    readiness: {freshness: "unknown", mergeability: "unknown", checks: "unknown", prerequisites: "unknown", unresolvedMaterialRisk: false},
    inspection: {findings, changes: [], coverage: [], limitations},
  });
  return bodies.summary + "\n\n---\n\n" + bodies.findings;
}
const expected = (name: string) => comparisonExpectations.find(item => item.name === name)!;

test("known misses remain labeled defects and do not become clean controls", () => {
  const result = assessCase(expected("empty-cart"), report());
  assert.equal(result.label, "defect");
  assert.equal(result.missedRoots, 1);
  assert.equal(result.cleanFalseBlock, false);
  assert.deepEqual(result.falseFindings, []);
  assert.match(renderBaseline([result]), /Missed roots:\n- empty-cart:/);
});

test("one root with duplicate valid findings is detected once", () => {
  const result = assessCase(expected("script-shared-target"), report([
    finding("call-a", "Missing npm script lint"), finding("call-b", "Missing npm script lint"),
  ]));
  assert.equal(result.detectedRoots, 1);
  assert.equal(result.missedRoots, 0);
  assert.equal(result.duplicateFindings, 1);
  assert.equal(result.falseFindings.length, 0);
  assert.equal(summarize([result]).detectedDefectCases, 1);
});

test("a matching claim with the wrong pinned location is not a detected defect", () => {
  const result = assessCase(expected("script-removed"), report([finding("wrong-line", "Missing npm script lint", 5)]));
  assert.equal(result.detectedRoots, 0);
  assert.equal(result.missedRoots, 1);
  assert.equal(result.falseFindings.length, 1);
});

test("clean findings and blocking recommendations have separate counts", () => {
  const clean = assessCase(expected("script-rename"), report());
  const falseBlock = assessCase(expected("script-rename"), report([finding("invented", "Missing npm script lint")]));
  assert.equal(clean.cleanFalseBlock, false);
  assert.equal(falseBlock.falseFindings.length, 1);
  assert.equal(falseBlock.cleanFalseBlock, true);
  const counts = summarize([clean, falseBlock]);
  assert.equal(counts.cleanCases, 2);
  assert.equal(counts.cleanFalseBlocks, 1);
  assert.equal(counts.falseFindings, 1);
});

test("unsupported comparisons are gaps with unscored findings", () => {
  const gap = assessCase(expected("script-optional"), report([finding("unlabeled", "A different claim")], ["npm configuration limits this check."]));
  assert.equal(gap.label, "gap");
  assert.equal(gap.gapDisclosed, true);
  assert.equal(gap.falseFindings.length, 0);
  assert.equal(gap.unscoredGapFindings.length, 1);
  assert.equal(gap.cleanFalseBlock, false);
  assert.equal(summarize([gap]).cleanCases, 0);
  const missingDisclosure = assessCase(expected("script-optional"), report());
  assert.equal(summarize([missingDisclosure]).gapsWithoutDisclosure, 1);
});

test("process and malformed-output failures leave roots unevaluated", () => {
  const failed = assessCase(expected("script-removed"), "", "Fixture process could not finish.");
  const malformed = assessCase(expected("empty-cart"), "No parseable review output.");
  const counts = summarize([failed, malformed]);
  assert.equal(counts.evaluationErrors, 2);
  assert.equal(counts.unevaluatedRoots, 2);
  assert.equal(counts.missedRoots, 0);
  assert.equal(counts.completedComparisons, 0);
});

test("a later supported finding can resolve a known miss", () => {
  const result = assessCase(expected("empty-cart"), report([finding("empty-input", "Empty cart reduce throws")]));
  assert.equal(result.detectedRoots, 1);
  assert.equal(result.missedRoots, 0);
  assert.equal(result.falseFindings.length, 0);
});
