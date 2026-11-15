import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const model = process.argv[2];
if (process.argv.length !== 3 || !model || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(model)) {
  console.error("Usage: pnpm check:model MODEL_ID");
  process.exit(2);
}

const fixture = fileURLToPath(new URL("../fixtures/review.ts", import.meta.url));
const cases = [
  { name: "empty-cart", path: "cart.mjs", symptom: /empty|reduce|accumulator/i },
  { name: "unchanged-consumer", path: "total.mjs", symptom: /export|import|binding/i },
  { name: "cart-refactor", path: null, symptom: null },
];

for (const item of cases) {
  const check = spawnSync(process.execPath, [fixture, item.name, "--anthropic-model", model], {
    encoding: "utf8", timeout: 120_000, maxBuffer: 128 * 1024, windowsHide: true,
  });
  const body = check.stdout ?? "";
  if (check.status !== 0 || !body.includes("Requested Anthropic model: " + model)
    || /API access is unavailable|within the review budget|could not establish a proposed regression|candidate lacked|investigation left part/i.test(body)) {
    console.error(item.name + ": live review unavailable or incomplete. Run its fixture to inspect the diagnostic.");
    process.exit(1);
  }
  const bugs = body.split("\n\n---\n\n")[1] ?? "";
  const findings = bugs.split(/(?=^\d+\. \*\*(?:LOW|MEDIUM|HIGH|CRITICAL)\*\*)/m).slice(1);
  // The static caller citation may also appear. The live model must still
  // identify the changed provider and its prior behavior independently.
  const modelFindings = findings.filter(finding => !(item.name === "unchanged-consumer"
    && /^\d+\. \*\*MEDIUM\*\* `Missing named export: total`$/m.test(finding)
    && finding.includes("Static evidence: `invoice.mjs:1` at")));
  const matches = item.path && item.symptom
    ? modelFindings.length === 1 && findings.length <= modelFindings.length + 1
      && item.symptom.test(modelFindings[0]!) && modelFindings[0]!.includes("Static evidence: `" + item.path + ":1` at")
      && body.includes("DO NOT MERGE")
    : findings.length === 0 && bugs.includes("No verified bugs found") && body.includes("HOLD");
  console.log("\n" + item.name + "\n" + body);
  if (!matches) {
    console.error("The live report did not match the expected finding and recommendation.");
    process.exit(1);
  }
}
console.log("All three live reports matched their fixture checks. Inspect the cited cause and fix in each report.");
