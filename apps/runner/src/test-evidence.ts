import type { Snapshot } from "./contracts.ts";
import { runSandboxCheck } from "./sandbox.ts";

export const nodeImage = "docker.io/library/node@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5";

export async function testEvidence(snapshot: Snapshot, path: string, run = runSandboxCheck): Promise<string[]> {
  if (!path.endsWith(".test.mjs")) return ["Select a self-contained .test.mjs file for the runtime check."];
  const notes = ["Isolated Node test: " + path + " using " + nodeImage + "."];
  for (const revision of ["merge_base", "head"] as const) {
    const source = await snapshot.read(revision, path);
    if (source.kind !== "text") {
      notes.push(revision + " " + snapshot[revision] + ": " + (source.kind === "missing" ? "file absent." : source.reason));
      continue;
    }
    const check = await run(source.text, nodeImage);
    notes.push(revision + " " + snapshot[revision] + ": " + check.status + ". " + check.detail);
  }
  return notes;
}
