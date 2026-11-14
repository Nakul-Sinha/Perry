import assert from "node:assert/strict";
import { test } from "node:test";
import type { Snapshot } from "../src/contracts.ts";
import { nodeImage, testEvidence } from "../src/test-evidence.ts";

test("an approved test compares the exact merge base and head and retains both outcomes", async () => {
  const snapshot: Snapshot = {
    base: "a".repeat(40), merge_base: "b".repeat(40), head: "c".repeat(40), changes: [],
    read: async (revision, path) => {
      assert.equal(path, "total.test.mjs");
      return { kind: "text", text: revision };
    },
  };
  const calls: string[] = [];
  const notes = await testEvidence(snapshot, "total.test.mjs", async (source, image) => {
    assert.equal(image, nodeImage);
    calls.push(source);
    return { status: source === "head" ? "failed" : "passed", detail: "Test finished." };
  });
  assert.deepEqual(calls, ["merge_base", "head"]);
  assert.ok(notes.some(note => note.includes(snapshot.merge_base + ": passed")));
  assert.ok(notes.some(note => note.includes(snapshot.head + ": failed")));
});
