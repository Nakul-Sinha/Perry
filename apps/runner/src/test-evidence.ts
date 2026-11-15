import type { Snapshot } from "./contracts.ts";
import { runSandboxCheck, safeModulePath } from "./sandbox.ts";

export const nodeImage = "docker.io/library/node@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5";

export async function testEvidence(snapshot: Snapshot, path: string, run = runSandboxCheck, modulePath?: string): Promise<string[]> {
  if (!path.endsWith(".test.mjs")) return ["Select a self-contained .test.mjs file for the runtime check."];
  if (modulePath && (!safeModulePath(path) || !safeModulePath(modulePath) || path === modulePath)) {
    return ["The selected test and source module must be distinct repository-relative ES module paths."];
  }
  const notes = ["Isolated Node test: " + path + " using " + nodeImage + "."];
  if (modulePath) notes.push("Selected source module: " + modulePath + ".");
  for (const revision of ["merge_base", "head"] as const) {
    const source = await snapshot.read(revision, path);
    if (source.kind !== "text") {
      notes.push(revision + " " + snapshot[revision] + ": " + (source.kind === "missing" ? "file absent." : source.reason));
      continue;
    }
    const module = modulePath ? await snapshot.read(revision, modulePath) : undefined;
    if (module && module.kind !== "text") {
      notes.push(revision + " " + snapshot[revision] + ": selected source module unavailable.");
      continue;
    }
    const payload = modulePath && module?.kind === "text" ? {testPath: path, modulePath, moduleSource: module.text} : undefined;
    const check = await run(source.text, nodeImage, 10000, payload);
    notes.push(revision + " " + snapshot[revision] + ": " + check.status + ". " + check.detail);
  }
  return notes;
}
