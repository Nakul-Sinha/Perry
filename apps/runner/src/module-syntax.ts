import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import type { Inspection, Snapshot } from "./contracts.ts";

type SyntaxCheck = { kind: "valid" } | { kind: "invalid"; line: number } | { kind: "unavailable" };
const maxModules = 24;
const maxBytes = 128 * 1024;

function checkSyntax(source: string): Promise<SyntaxCheck> {
  if (process.versions.node.split(".")[0] !== "24" || Buffer.byteLength(source) > maxBytes) {
    return Promise.resolve({ kind: "unavailable" });
  }
  return new Promise(resolve => {
    const child = execFile(process.execPath, ["--input-type=module", "--check", "-"], {
      cwd: tmpdir(), env: { SystemRoot: process.env.SystemRoot },
      timeout: 2000, maxBuffer: 16 * 1024, windowsHide: true,
    }, (error, stdout, stderr) => {
      if (!error && stdout === "" && stderr === "") return resolve({ kind: "valid" });
      if (error?.code !== 1 || error.signal || stdout !== "") return resolve({ kind: "unavailable" });
      // Match the parser's frame and stack. Never forward diagnostics that quote source.
      const frame = /^\[stdin\]:(\d+)\r?\n[^\r\n]*\r?\n[\t ^]*\r?\n\r?\nSyntaxError: [^\r\n]+\r?\n +at checkSyntax \(node:internal\/main\/check_syntax:/.exec(stderr);
      if (!frame || /\r(?!\n)|[\u2028\u2029]/u.test(source)) return resolve({ kind: "unavailable" });
      const line = Number(frame[1]);
      const lines = source.split("\n").length;
      if (line < 1 || line > lines) return resolve({ kind: "unavailable" });
      // Node points to the virtual empty line at EOF for an unclosed construct.
      resolve({ kind: "invalid", line: source.endsWith("\n") ? Math.min(line, lines - 1) : line });
    });
    child.stdin!.on("error", () => resolve({ kind: "unavailable" }));
    child.stdin!.end(source);
  });
}

export async function inspectModules(snapshot: Snapshot): Promise<Inspection> {
  const result: Inspection = { changes: [], findings: [], coverage: [], limitations: [] };
  if (!snapshot.changes.length) return result;
  result.limitations.push("The Node 24 syntax check parses source without running project code.");
  const actions = { added: 0, modified: 0, type_changed: 0, deleted: 0 };
  for (const [index, { path, status, previousPath }] of snapshot.changes.entries()) {
    actions[status]++;
    const record = (disposition: "incomplete" | "checked", reason: string) => {
      result.coverage.push({ path, disposition, reason });
    };
    if (!path.endsWith(".mjs") || index >= maxModules) {
      record("incomplete", "Outside the .mjs profile or the 24-module inspection budget.");
      continue;
    }
    if (status === "deleted") {
      record("incomplete", "Module removed. Dependent imports require a separate check.");
      continue;
    }
    const current = await snapshot.read("head", path);
    if (current.kind !== "text") {
      record("incomplete", "Head source is unavailable for syntax checking.");
      continue;
    }
    const head = await checkSyntax(current.text);
    if (head.kind === "valid") {
      record("checked", "Node 24 accepted the module syntax.");
      continue;
    }
    if (head.kind === "unavailable") {
      record("incomplete", "Node 24 could not supply a bounded, recognizable syntax result.");
      continue;
    }
    const previous = await snapshot.read("merge_base", previousPath ?? path);
    if (status === "added" && !previousPath && previous.kind !== "missing") {
      record("incomplete", "The alleged addition already has an entry at the merge base or could not be verified.");
      continue;
    }
    if (previousPath && !previousPath.endsWith(".mjs")) {
      record("incomplete", "The previous path had a different module type.");
      continue;
    }
    if (status !== "added" || previousPath) {
      if (previous.kind !== "text") {
        record("incomplete", "The prior source could not establish a syntax baseline.");
        continue;
      }
      const baseline = await checkSyntax(previous.text);
      if (baseline.kind === "invalid") {
        record("checked", "Node 24 rejects the module on both revisions.");
        continue;
      }
      if (baseline.kind !== "valid") {
        record("incomplete", "A consistent syntax baseline could not be established.");
        continue;
      }
    }
    record("checked", "Node 24 rejected the new module syntax.");
    result.findings.push({
      id: "node-esm-syntax:" + path, title: "Module fails to parse", severity: "medium",
      trigger: "Node 24 attempts to load the changed ES module.",
      impact: "Module loading stops at parse time, before the module body runs.",
      fix: "Correct the syntax at or immediately before the cited line and rerun node --check on this module.",
      evidence: { sha: snapshot.head, path, line: head.line },
    });
  }
  const counts = Object.entries(actions).filter(([, n]) => n > 0).map(([status, count]) =>
    count + " " + (status === "type_changed" ? "changed type" : status));
  result.changes.push("ES module files changed (" + counts.join(", ") + ").");
  return result;
}
