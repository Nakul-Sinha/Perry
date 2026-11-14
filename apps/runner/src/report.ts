import type { Finding, ReportInput, Severity } from "./contracts.ts";

const deductions: Record<Severity, number> = { low: 0.25, medium: 1, high: 3, critical: 6 };
const caps: Record<Severity, number> = { low: 10, medium: 7, high: 5, critical: 3 };
type Recommendation = "MERGE" | "HOLD" | "DO NOT MERGE";

// A code span keeps source text literal in GitHub Markdown, including mentions,
// HTML, URLs and user-supplied Markdown. Prevent newlines from ending the span.
function literal(value: string): string {
  const line = value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").trim();
  if (!line) return "(empty)";
  let width = 1;
  for (const match of line.matchAll(/`+/g)) width = Math.max(width, match[0].length + 1);
  const fence = "`".repeat(width);
  return line.includes("`") ? `${fence} ${line} ${fence}` : `${fence}${line}${fence}`;
}

function prose(value: string): string {
  const simpleSentence = /^[a-z0-9][a-z0-9 ,'-]*[.!?]?$/i;
  return simpleSentence.test(value) && !/\b[a-f0-9]{7,64}\b/i.test(value) ? value : literal(value);
}

function distinctFindings(findings: Finding[]): Finding[] {
  const byCause = new Map<string, Finding>();
  for (const finding of findings) {
    const previous = byCause.get(finding.id);
    if (!previous || deductions[finding.severity] > deductions[previous.severity]) {
      byCause.set(finding.id, finding);
    }
  }
  return [...byCause.values()];
}

function readiness(input: ReportInput, findings: Finding[], partial: boolean) {
  const { assessment, readiness: facts } = input;
  if (assessment === "stale" || facts.freshness === "stale") {
    return { score: 0, recommendation: "HOLD" as const, provisional: true, reason: "The assessment is stale." };
  }
  if (assessment !== "completed" && assessment !== "partial") {
    const reason = assessment === "unassessed" ? "No changed path could be assessed." : `Assessment ${assessment}.`;
    return { score: 0, recommendation: "HOLD" as const, provisional: true, reason };
  }
  if (!input.snapshot) {
    return { score: 0, recommendation: "HOLD" as const, provisional: true, reason: "No commit snapshot was available." };
  }

  let points = 10;
  let cap = 10;
  for (const finding of findings) {
    points -= deductions[finding.severity];
    cap = Math.min(cap, caps[finding.severity]);
  }
  const materialCount = findings.filter(finding => finding.severity !== "low").length;
  const blockers: string[] = [];
  if (materialCount) blockers.push(`${materialCount} material finding${materialCount === 1 ? "" : "s"}`);
  if (facts.checks === "failed") blockers.push("required checks failed");
  if (facts.mergeability === "conflicts") blockers.push("merge conflict");
  const gaps: string[] = [];
  if (facts.freshness === "unknown") gaps.push("freshness unknown");
  if (facts.mergeability === "unknown") gaps.push("GitHub mergeability unknown");
  if (facts.checks === "unknown" || facts.checks === "pending") gaps.push(`required checks ${facts.checks}`);
  if (facts.prerequisites !== "satisfied") gaps.push(`merge prerequisites ${facts.prerequisites}`);
  if (gaps.length) cap = Math.min(cap, 7);
  if (partial) gaps.push("incomplete coverage");
  if (facts.unresolvedMaterialRisk) gaps.push("unresolved material risk");
  if (facts.checks === "failed" || facts.mergeability === "conflicts" || partial || facts.unresolvedMaterialRisk) {
    cap = Math.min(cap, 4);
  }
  const recommendation: Recommendation = blockers.length ? "DO NOT MERGE" : gaps.length ? "HOLD" : "MERGE";
  const reasons = [...blockers, ...gaps];
  return {
    score: Math.max(0, Math.min(cap, Math.floor(points))),
    recommendation,
    provisional: gaps.length > 0,
    reason: reasons.length ? reasons.join(", ") + "." : "Reviewed scope and GitHub prerequisites are clear.",
  };
}

export function renderReport(input: ReportInput) {
  const { inspection, snapshot } = input;
  const findings = distinctFindings(inspection.findings);
  const checked = inspection.coverage.filter(entry => entry.disposition === "checked").length;
  const partial = input.assessment === "partial" || checked < inspection.coverage.length;
  const result = readiness(input, findings, partial);
  const currentAssessment = snapshot !== null && input.readiness.freshness !== "stale"
    && (input.assessment === "completed" || input.assessment === "partial");
  const summary = [
    "## Perry review",
    `**${result.recommendation} | ${result.score}/10 merge readiness${result.provisional ? " (provisional)" : ""}**`,
    result.reason,
  ];
  if (snapshot) {
    const refs = [`Head ${literal(snapshot.head)}`, `Base ${literal(snapshot.base)}`];
    if (snapshot.merge_base !== snapshot.base) refs.push(`Merge base ${literal(snapshot.merge_base)}`);
    summary.push(refs.join(" | "));
  }
  if (!currentAssessment && inspection.limitations[0]) summary.push(prose(inspection.limitations[0]));
  if (currentAssessment && inspection.changes.length) {
    const bullets = inspection.changes.slice(0, 6).map(change => `- ${prose(change)}`);
    if (inspection.changes.length > bullets.length) {
      bullets.push(`- ${inspection.changes.length - bullets.length} additional summary items.`);
    }
    summary.push(bullets.join("\n"));
  }
  if (currentAssessment) {
    const checks = input.readiness.checks.replace("_", " ");
    summary.push(`Coverage: ${checked}/${inspection.coverage.length} changed paths checked. GitHub required checks: ${checks}.`);
  }

  const bugs = ["## Bugs and suggested fixes"];
  if (snapshot) bugs.push(`Head ${literal(snapshot.head)}`);
  if (!currentAssessment) bugs.push(`${result.reason} No current bug assessment is available.`);
  else if (!findings.length) bugs.push("No verified bugs found within the reviewed scope.");
  if (findings.length && !currentAssessment) bugs.push("Earlier observations at their recorded revisions:");
  for (const [index, finding] of findings.entries()) {
    const { path, line, sha } = finding.evidence;
    bugs.push([
      `${index + 1}. **${finding.severity.toUpperCase()}** ${prose(finding.title)}`,
      `   - Trigger: ${prose(finding.trigger)}`,
      `   - Impact: ${prose(finding.impact)}`,
      `   - Static evidence: ${literal(`${path}:${line}`)} at ${literal(sha)}`,
      `   - Suggested fix (untested): ${prose(finding.fix)}`,
    ].join("\n"));
  }
  if (partial) {
    const missing = inspection.coverage
      .filter(entry => entry.disposition === "incomplete")
      .map(entry => `- ${literal(entry.path)}: ${prose(entry.reason)}`);
    bugs.push(missing.length
      ? `Coverage is partial: ${checked}/${inspection.coverage.length} changed paths checked.`
      : "Coverage is partial. Every changed path received a scoped check. See the limitations below.");
    if (missing.length) bugs.push(missing.join("\n"));
  }
  if (inspection.limitations.length) {
    bugs.push("Limitations\n\n" + inspection.limitations.map(item => `- ${prose(item)}`).join("\n"));
  }
  if (input.checksRun?.length) bugs.push("Runtime evidence\n\n" + input.checksRun.map(item => "- " + prose(item)).join("\n"));
  return {
    summary: summary.join("\n\n"),
    findings: bugs.join("\n\n"),
    score: result.score,
    recommendation: result.recommendation,
  };
}
