import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { comparisonExpectations, type ComparisonExpectation } from "../fixtures/expectations.ts";

type Label = "defect" | "clean" | "gap";
export interface CaseResult {
  name: string;
  label: Label;
  expectedRoot: string | null;
  expectedLocation: string | null;
  expectedLimitation: string | null;
  detectedRoots: number;
  missedRoots: number;
  falseFindings: string[];
  duplicateFindings: number;
  unscoredGapFindings: string[];
  cleanFalseBlock: boolean;
  gapDisclosed: boolean | null;
  recommendation: "MERGE" | "HOLD" | "DO NOT MERGE" | null;
  error: string | null;
  report: string;
}

function label(item: ComparisonExpectation): Label {
  return item.finding || item.knownMiss ? "defect" : item.limitation ? "gap" : "clean";
}

export function assessCase(item: ComparisonExpectation, report: string, error: string | null = null): CaseResult {
  const root = item.finding ?? item.knownMiss;
  const result: CaseResult = {
    name: item.name, label: label(item), expectedRoot: root?.toString() ?? null,
    expectedLocation: item.location ?? null, expectedLimitation: item.limitation?.toString() ?? null,
    detectedRoots: 0, missedRoots: 0,
    falseFindings: [], duplicateFindings: 0, unscoredGapFindings: [], cleanFalseBlock: false,
    gapDisclosed: null, recommendation: null, error, report,
  };
  if (error) return result;
  const parts = report.split("\n\n---\n\n");
  const summary = parts[0] ?? "";
  const bugs = parts[1] ?? "";
  const head = /Head `([a-f0-9]{40,64})`/.exec(summary)?.[1];
  const recommendation = /\*\*(MERGE|HOLD|DO NOT MERGE) \| (?:10|[0-9])\/10 merge readiness/.exec(summary)?.[1];
  if (parts.length !== 2 || !summary.startsWith("## Perry review")
    || !bugs.startsWith("## Bugs and suggested fixes") || !head || !recommendation) {
    result.error = "The fixture did not produce the expected two-comment report.";
    return result;
  }
  result.recommendation = recommendation as CaseResult["recommendation"];
  const findings = bugs.match(/^\d+\. \*\*(?:LOW|MEDIUM|HIGH|CRITICAL)\*\* .+$(?:\n[^\n]+)*/gm) ?? [];
  if (result.label === "gap") {
    result.unscoredGapFindings = findings;
    result.gapDisclosed = item.limitation!.test(bugs);
    return result;
  }
  const matching = findings.filter(finding => root?.test(finding)
    && (!item.location || finding.includes("`" + item.location + "` at `" + head + "`")));
  result.detectedRoots = matching.length ? 1 : 0;
  result.missedRoots = root && !matching.length ? 1 : 0;
  result.duplicateFindings = Math.max(0, matching.length - 1);
  result.falseFindings = findings.filter(finding => !matching.includes(finding));
  result.cleanFalseBlock = result.label === "clean" && recommendation === "DO NOT MERGE";
  return result;
}

export function summarize(cases: CaseResult[]) {
  const sum = (count: (item: CaseResult) => number) => cases.reduce((total, item) => total + count(item), 0);
  return {
    comparisons: cases.length,
    completedComparisons: sum(item => item.error ? 0 : 1),
    defectCases: sum(item => item.label === "defect" ? 1 : 0),
    cleanCases: sum(item => item.label === "clean" ? 1 : 0),
    gapCases: sum(item => item.label === "gap" ? 1 : 0),
    detectedDefectCases: sum(item => item.detectedRoots ? 1 : 0),
    expectedRoots: sum(item => item.expectedRoot ? 1 : 0),
    detectedRoots: sum(item => item.detectedRoots),
    missedRoots: sum(item => item.missedRoots),
    unevaluatedRoots: sum(item => item.expectedRoot && item.error ? 1 : 0),
    falseFindings: sum(item => item.falseFindings.length),
    duplicateFindings: sum(item => item.duplicateFindings),
    unscoredGapFindings: sum(item => item.unscoredGapFindings.length),
    cleanFalseBlocks: sum(item => item.cleanFalseBlock ? 1 : 0),
    gapsWithoutDisclosure: sum(item => item.gapDisclosed === false ? 1 : 0),
    evaluationErrors: sum(item => item.error ? 1 : 0),
  };
}

export function renderBaseline(cases: CaseResult[]) {
  const totals = summarize(cases);
  const rows = cases.map(item => [item.name, item.label, item.error ? "error" : item.recommendation,
    item.detectedRoots, item.missedRoots, item.falseFindings.length,
    item.duplicateFindings, item.unscoredGapFindings.length].join(" | "));
  const lines = [
    "Perry static fixture baseline", "",
    "Synthetic comparisons only. No model calls, runtime experiments, or live GitHub checks.",
    "The current labels define one root cause per defective comparison; gaps are not clean cases.", "",
    `Completed comparisons: ${totals.completedComparisons}/${totals.comparisons}`,
    `Defect cases detected: ${totals.detectedDefectCases}/${totals.defectCases}`,
    `Expected roots: ${totals.expectedRoots}; detected: ${totals.detectedRoots}; missed: ${totals.missedRoots}; unevaluated: ${totals.unevaluatedRoots}`,
    `False findings in labeled defect/clean cases: ${totals.falseFindings}; duplicate findings: ${totals.duplicateFindings}`,
    `Clean-case false blocks: ${totals.cleanFalseBlocks}/${totals.cleanCases}`,
    `Coverage-gap cases: ${totals.gapCases}; unscored findings: ${totals.unscoredGapFindings}; missing gap disclosures: ${totals.gapsWithoutDisclosure}`,
    `Evaluation errors: ${totals.evaluationErrors}`, "",
    "case | label | recommendation | detected roots | missed roots | false findings | duplicates | unscored",
    ...rows, "", "Missed roots:",
    ...cases.filter(item => item.missedRoots).map(item => `- ${item.name}: ${item.expectedRoot}`),
    "", "Findings needing inspection:",
    ...cases.flatMap(item => [
      ...item.falseFindings.map(finding => `- ${item.name} false finding:\n${finding}`),
      ...item.unscoredGapFindings.map(finding => `- ${item.name} unscored gap finding:\n${finding}`),
      ...(item.error ? [`- ${item.name}: ${item.error}`] : []),
      ...(item.gapDisclosed === false ? [`- ${item.name}: expected gap disclosure ${item.expectedLimitation} was absent.`] : []),
    ]),
    "", "Use --details for all report bodies or --json for the complete machine-readable result.",
    "These development fixtures are not a held-out estimate of general review quality.",
  ];
  return lines.join("\n");
}

export function main(args: string[]) {
  if (args.length > 1 || (args.length === 1 && !["--json", "--details"].includes(args[0]!))) {
    console.error("Usage: pnpm check:baseline [--json | --details]");
    return 2;
  }
  const fixture = fileURLToPath(new URL("../fixtures/review.ts", import.meta.url));
  const cases = comparisonExpectations.map(item => {
    const run = spawnSync(process.execPath, [fixture, item.name], {
      encoding: "utf8", timeout: 60_000, maxBuffer: 512 * 1024, windowsHide: true,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP },
    });
    const error = run.error ? "Fixture process could not finish."
      : run.status !== 0 ? "Fixture exited with status " + run.status + "." : null;
    return assessCase(item, run.stdout ?? "", error);
  });
  if (args[0] === "--json") console.log(JSON.stringify({version: 1, mode: "static", totals: summarize(cases), cases}, null, 2));
  else {
    console.log(renderBaseline(cases));
    if (args[0] === "--details") for (const item of cases) console.log("\n=== " + item.name + " ===\n" + item.report);
  }
  return cases.some(item => item.error) ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
