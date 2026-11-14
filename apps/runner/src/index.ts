import { parseArgs } from "node:util";
import type { ReportInput, Snapshot } from "./contracts.ts";
import { inspect } from "./inspect.ts";
import { inspectModules } from "./module-syntax.ts";
import { inspectImports } from "./module-imports.ts";
import { renderReport } from "./report.ts";
import { openSnapshot } from "./snapshot.ts";
import { testEvidence } from "./test-evidence.ts";
import { collectContext } from "./model-context.ts";
import { anthropicBackend, investigate } from "./model-review.ts";

const usage = [
  "Usage: pnpm review:local --repo <checkout-root> --base <full-commit-id> --head <full-commit-id>",
  "Add --test <path.test.mjs> to run a self-contained test in rootless Podman.",
  "Add --anthropic-model <id> to send selected committed source to the Anthropic API.",
].join("\n");

// A local Git object proves which bytes were inspected. It cannot establish
// that these are the latest commits on GitHub or that branch rules passed.
const localReadiness: ReportInput["readiness"] = {
  freshness: "unknown", mergeability: "unknown", checks: "unknown",
  prerequisites: "unknown", unresolvedMaterialRisk: false,
};

async function run(args: string[]) {
  if (!args.length || (args.length === 1 && ["--help", "-h"].includes(args[0]!))) {
    console.log(usage);
    return 0;
  }
  let options;
  try {
    if (args[0] !== "review") throw new Error();
    options = parseArgs({
      args: args.slice(1), allowPositionals: false,
      options: {
        repo: { type: "string" }, base: { type: "string" }, head: { type: "string" },
        test: { type: "string" }, "anthropic-model": { type: "string" },
      },
    }).values;
    if (!options.repo || !options.base || !options.head) throw new Error();
  } catch {
    console.error(usage);
    return 2;
  }

  let snapshot: Snapshot | null = null;
  let input: ReportInput;
  try {
    snapshot = await openSnapshot(options.repo, options.base, options.head);
    const modulePaths = snapshot.changes.filter(change => change.path.endsWith(".mjs"));
    const otherPaths = snapshot.changes.filter(change => !change.path.endsWith(".mjs"));
    const manifest = await inspect({ ...snapshot, changes: otherPaths });
    const moduleSnapshot = { ...snapshot, changes: modulePaths };
    const modules = await inspectModules(moduleSnapshot);
    const imports = await inspectImports(snapshot);
    const coverage = [...manifest.coverage, ...modules.coverage];
    const checked = coverage.some(entry => entry.disposition === "checked");
    const findings = [...manifest.findings, ...modules.findings, ...imports.findings];
    const limitations = ["Local preview. Full application behavior, repository plans and live GitHub checks were not reviewed."];
    limitations.push(...manifest.limitations, ...modules.limitations, ...imports.limitations);
    if (!coverage.length) limitations.push("The merge base and head have identical tracked trees.");
    let assessment: ReportInput["assessment"] = "unassessed";
    if (!coverage.length) assessment = "completed";
    else if (checked || findings.length) assessment = "partial";
    const model = options["anthropic-model"];
    if (model) {
      const context = await collectContext(snapshot);
      const reviewed = await investigate(context.files, anthropicBackend(model));
      limitations[0] = "Local preview. Application behavior and live GitHub prerequisites remain partially assessed.";
      limitations.push("Requested Anthropic model: " + model + ".", ...context.limitations, ...reviewed.limitations);
      for (const finding of reviewed.findings) {
        if (!findings.some(other => other.evidence.path === finding.evidence.path
          && other.evidence.line === finding.evidence.line && other.title === finding.title)) {
          findings.push(finding);
        }
      }
      if (reviewed.assessed) {
        const seen = new Set(context.files.filter(file => file.ref === "head" && file.changed).map(file => file.path));
        for (const entry of coverage) {
          if (entry.disposition === "incomplete" && seen.has(entry.path)) {
            entry.disposition = "checked";
            entry.reason = "Included in the bounded model investigation.";
          }
        }
        if (seen.size) assessment = "partial";
      }
    }
    input = {
      snapshot, readiness: localReadiness,
      assessment,
      inspection: { coverage, findings, changes: [...manifest.changes, ...modules.changes], limitations },
    };
    if (options.test) input.checksRun = await testEvidence(snapshot, options.test);
  } catch (error) {
    // Only snapshot acquisition errors have diagnostics written for the user.
    const reason = !snapshot && error instanceof Error ? error.message : "Local inspection could not finish.";
    input = {
      snapshot, readiness: localReadiness, assessment: "failed",
      inspection: { changes: [], findings: [], coverage: [], limitations: [reason] },
    };
  }
  const report = renderReport(input);
  console.log(report.summary + "\n\n---\n\n" + report.findings);
  return input.assessment === "failed" ? 1 : 0;
}

process.exitCode = await run(process.argv.slice(2));
