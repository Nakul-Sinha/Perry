import assert from "node:assert/strict";
import { test } from "node:test";
import type { Snapshot } from "../src/contracts.ts";
import { collectContext } from "../src/model-context.ts";

test("picks approved plans and unchanged importers without including local configuration", async () => {
  const source: Record<string, string> = {
    "total.ts": "export const total = 1;",
    "billing.ts": "import {total} from './total.ts';",
    "docs/plan.md": "Approved calculation.",
    ".env.ts": "Private local settings.",
    "credentials.ts": "Local configuration.",
    "example.ts": "const example = 'ghp_'",
  };
  const snapshot: Snapshot = {
    base: "1".repeat(40), head: "2".repeat(40), merge_base: "3".repeat(40),
    changes: [{path: "total.ts", status: "modified"}, {path: ".env.ts", status: "added"}],
    listPaths: async () => Object.keys(source),
    read: async (ref, path) => {
      assert.ok(![".env.ts", "credentials.ts"].includes(path));
      if (path === "docs/plan.md") assert.equal(ref, "base");
      const text = source[path];
      return text ? {kind: "text", text} : {kind: "missing"};
    },
  };
  const {files} = await collectContext(snapshot);
  assert.deepEqual(files.map(file => [file.ref, file.path]), [
    ["head", "total.ts"], ["merge_base", "total.ts"], ["base", "docs/plan.md"], ["head", "billing.ts"],
  ]);
});
