import type { BlobRead, Finding, Inspection, Snapshot } from "./contracts.ts";

// Bound the work per review before admitting more manifests or script checks.
const manifestBudget = 32;
const scriptBudget = 128;
const implicitScripts = new Set(["env", "restart", "start", "install"]);
const directRun = /^[ \t]*npm[ \t]+run[ \t]+([A-Za-z0-9][A-Za-z0-9_:.-]{0,95})[ \t]*$/;
const simpleName = /^[A-Za-z0-9][A-Za-z0-9_:.-]{0,95}$/;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

type Manifest =
  | { kind: "valid"; scripts: Record<string, unknown> }
  | { kind: "invalid"; line: number | null }
  | { kind: "unavailable"; reason: string };

function parseManifest(blob: BlobRead): Manifest {
  if (blob.kind === "unavailable") return blob;
  if (blob.kind === "missing") return { kind: "unavailable", reason: "Expected manifest is missing." };
  const text = blob.text.replace(/^\uFEFF/, "");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    const message = error instanceof SyntaxError ? error.message : "";
    const position = /at position (\d+)(?: \(line \d+ column \d+\))?$/.exec(message);
    const offset = position ? Number(position[1]) : null;
    const line = offset !== null && offset < text.length ? text.slice(0, offset).split("\n").length : null;
    return { kind: "invalid", line };
  }
  if (!record(value) || (Object.hasOwn(value, "scripts") && !record(value.scripts))) {
    return { kind: "unavailable", reason: "Unsupported package manifest or scripts object." };
  }
  return { kind: "valid", scripts: record(value.scripts) ? value.scripts : {} };
}

// JSON.parse validated the input. Record the effective (last) key location,
// including escaped keys, without treating nested objects as package scripts.
function scriptLines(text: string): Map<string, number> {
  const lines = new Map<string, number>();
  let depth = 0;
  let line = 1;
  let nextIsKey = false;
  let inScripts = false;
  for (const [token] of text.matchAll(/"(?:\\.|[^"\\])*"|[[\]{},\n]/g)) {
    if (token === "\n") {
      line++;
    } else if (token === "{" || token === "[") {
      depth++;
      nextIsKey = token === "{";
    } else if (token === "}" || token === "]") {
      depth--;
      nextIsKey = false;
    } else if (token === ",") {
      nextIsKey = true;
    } else if (nextIsKey) {
      if (depth === 1) {
        inScripts = JSON.parse(token) === "scripts";
        if (inScripts) lines.clear();
      } else if (depth === 2 && inScripts) {
        lines.set(JSON.parse(token), line);
      }
      nextIsKey = false;
    }
  }
  return lines;
}

function targetOf(script: unknown): string | undefined {
  return typeof script === "string" ? directRun.exec(script)?.[1] : undefined;
}

function inspectScripts(
  path: string, sha: string, text: string, before: Record<string, unknown>, after: Record<string, unknown>,
): Finding[] {
  const lines = scriptLines(text);
  const findings = new Map<string, Finding>();
  for (const [caller, script] of Object.entries(after)) {
    const target = targetOf(script);
    if (!target || implicitScripts.has(target) || Object.hasOwn(after, target) || !simpleName.test(caller)) continue;
    if (after[`pre${caller}`]) continue; // A pre-hook can change the manifest before npm runs again.
    if (targetOf(before[caller]) === target && typeof before[target] !== "string") continue;
    const line = lines.get(caller);
    if (!line || findings.has(target)) continue;
    findings.set(target, {
      id: `missing-script:${path}/${target}`,
      severity: "medium",
      title: `Missing npm script ${target}`,
      trigger: `Run npm run ${caller} in this package with default npm script settings.`,
      impact: `The caller delegates directly to ${target}, which is absent from the committed scripts. npm reports a missing script.`,
      fix: `Define ${target} in this package or update ${caller} to invoke the intended existing script.`,
      evidence: { sha, path, line },
    });
  }
  return [...findings.values()];
}

function describeScripts(path: string, before: Record<string, unknown>, after: Record<string, unknown>): string | undefined {
  const added = Object.keys(after).filter(key => !Object.hasOwn(before, key));
  const removed = Object.keys(before).filter(key => !Object.hasOwn(after, key));
  const updated = Object.keys(after).filter(key => Object.hasOwn(before, key) && typeof after[key] === "string" && before[key] !== after[key]);
  const details: string[] = [];
  for (const [label, names] of [["added", added], ["removed", removed], ["updated", updated]] as const) {
    if (!names.length) continue;
    const list = names.length <= 3 && names.every(name => simpleName.test(name)) ? names.join(", ") : `${names.length} scripts`;
    details.push(`${label} ${list}`);
  }
  return details.length ? `Changed npm scripts in ${path} (${details.join(", ")}).` : undefined;
}

const verbs = { added: "Added", modified: "Modified", deleted: "Deleted", type_changed: "Changed file type for" };

async function hasCustomNpmConfig(
  snapshot: Snapshot, path: string, cache: Map<string, boolean>,
): Promise<boolean> {
  const parts = path.split("/");
  if (parts.length > 16) return true;
  for (let depth = 0; depth < parts.length; depth++) {
    const config = [...parts.slice(0, depth), ".npmrc"].join("/");
    let custom = cache.get(config);
    if (custom === undefined) {
      const blob = await snapshot.read("head", config);
      custom = blob.kind === "unavailable" || (blob.kind === "text" && blob.text.split(/\r?\n/).some(line => {
        const setting = line.trim();
        return setting.length > 0 && !/^[#;]/.test(setting);
      }));
      cache.set(config, custom);
    }
    if (custom) return true;
  }
  return false;
}

export async function inspect(snapshot: Snapshot): Promise<Inspection> {
  const result: Inspection = {
    changes: [], findings: [], coverage: [],
    limitations: [],
  };
  let manifestCount = 0;
  const configs = new Map<string, boolean>();
  for (const { path, status, previousPath } of snapshot.changes) {
    let summary = previousPath ? `Moved ${previousPath} to ${path}.` : `${verbs[status]} ${path}.`;
    let gap: string | undefined;
    if (path.split("/").at(-1) !== "package.json") {
      gap = "Outside the package manifest checks.";
    } else if (status === "deleted") {
      gap = "Impact of removing this package was not assessed.";
    } else if (previousPath && previousPath.split("/").at(-1) !== "package.json") {
      gap = "The previous path was outside package manifest checks.";
    } else if (++manifestCount > manifestBudget) {
      gap = "Reached the per-review manifest limit.";
    } else {
      const headBlob = await snapshot.read("head", path);
      const head = parseManifest(headBlob);
      const base = status === "added" && !previousPath ? { kind: "valid", scripts: {} } as const
        : parseManifest(await snapshot.read("merge_base", previousPath ?? path));
      if (head.kind === "unavailable") {
        gap = head.reason;
      } else if (base.kind !== "valid") {
        gap = "Cannot establish a valid merge-base manifest for comparison.";
      } else if (head.kind === "invalid") {
        if (head.line !== null) {
          result.findings.push({
            id: `invalid-json:${path}`, severity: "high", title: "Invalid package manifest JSON",
            trigger: `Read ${path} with a JSON package manifest parser.`,
            impact: "Consumers cannot parse this package definition.",
            fix: "Restore valid JSON and verify the committed manifest parses.",
            evidence: { sha: snapshot.head, path, line: head.line },
          });
          gap = "Invalid JSON prevents script inspection.";
        } else {
          gap = "Head manifest contains invalid JSON. The parser did not locate an error inside a source line.";
        }
      } else if (Object.keys(base.scripts).length > scriptBudget || Object.keys(head.scripts).length > scriptBudget) {
        gap = "JSON parsed. Script count exceeds the per-manifest limit.";
      } else if (headBlob.kind === "text") {
        const candidates = inspectScripts(path, snapshot.head, headBlob.text, base.scripts, head.scripts);
        if (candidates.length && await hasCustomNpmConfig(snapshot, path, configs)) {
          gap = "Custom or unavailable npm configuration prevents verification under default script settings.";
        } else {
          result.findings.push(...candidates);
        }
        if (status === "modified") summary = describeScripts(path, base.scripts, head.scripts) ?? summary;
      }
    }
    result.coverage.push({ path, disposition: gap ? "incomplete" : "checked", reason: gap ?? "Checked JSON syntax and direct npm script delegation." });
    if (result.changes.length < 5) result.changes.push(summary);
  }
  if (snapshot.changes.length > result.changes.length) {
    result.changes.push(`Changed ${snapshot.changes.length - result.changes.length} additional files.`);
  }
  if (manifestCount) {
    result.limitations.push("Manifest analysis checks JSON syntax and direct npm script delegation under default settings. Package scripts were inspected as source only.");
  }
  return result;
}
