import assert from "node:assert/strict";
import { test } from "node:test";
import { answerQuestion } from "../src/answer.ts";
import type { Snapshot } from "../src/contracts.ts";

const commit = "2".repeat(40);
function fixture(files: Record<string, string>) {
  const reads: string[] = [];
  const snapshot: Snapshot = {
    base: "1".repeat(40), merge_base: "1".repeat(40), head: commit, changes: [],
    listPaths: async ref => { assert.equal(ref, "head"); return Object.keys(files); },
    read: async (ref, path) => {
      assert.equal(ref, "head");
      reads.push(path);
      assert.ok(Object.hasOwn(files, path));
      return { kind: "text", text: files[path]! };
    },
  };
  return { reads, snapshot };
}

const files = { "fees.ts": "// Pricing\nexport function subtotal(x) {\n  return x + 2;\n}\n", "checkout.ts": "return subtotal(amount)\n" };

test("source-only answers include real head lines without a provider or a rating", async () => {
  const { snapshot } = fixture(files);
  const answer = await answerQuestion(snapshot, "How does subtotal work?", undefined, () => { throw new Error("Unexpected provider"); });
  assert.match(answer, /Matching committed source/);
  assert.ok(answer.includes(commit));
  assert.match(answer, /fees\.ts:2-3/);
  assert.match(answer, /checkout\.ts:1/);
  assert.match(answer, /return x \+ 2/);
  assert.doesNotMatch(answer, /\/10|## Perry review|DO NOT MERGE/);
});

test("the provider sees filtered excerpts and selects actual deduplicated citations", async () => {
  const { snapshot } = fixture(files);
  let calls = 0;
  const answer = await answerQuestion(snapshot, "subtotal fees.ts", "fixture", () => async (role, payload) => {
    calls++;
    assert.equal(role, "question");
    const { excerpts } = JSON.parse(payload);
    const index = excerpts.findIndex((item: {path: string}) => item.path === "fees.ts");
    assert.ok(index >= 0);
    return JSON.stringify({ answer: "The subtotal increases by two.", citations: [index, index] });
  });
  assert.equal(calls, 1);
  assert.match(answer, /subtotal increases by two/);
  assert.equal(answer.split("fees.ts:2-3").length, 2);
  assert.doesNotMatch(answer, /checkout\.ts/);
});

test("invalid citations, sensitive answers and missing evidence suppress unsupported claims", async () => {
  const { snapshot } = fixture(files);
  for (const reply of [
    { answer: "unsupported", citations: [10] }, { answer: "unsupported", citations: ["0"] },
    { answer: "unsupported", citations: [-1, 0] }, { answer: "unsupported", citations: [] },
    { answer: 'password = "private-answer"', citations: [0] },
  ]) {
    const answer = await answerQuestion(snapshot, "subtotal", "fixture", () => async () => JSON.stringify(reply));
    assert.match(answer, /did not establish an answer/);
    assert.doesNotMatch(answer, /unsupported|private-answer/);
  }
  const noSource = await answerQuestion(snapshot, "unknown_field", "fixture", () => { throw new Error("Unexpected provider"); });
  assert.match(noSource, /did not establish an answer/);
});

test("secrets in questions, paths and file contents never enter the callback or output", async () => {
  const { snapshot, reads } = fixture({
    ...files, ".private.ts": "subtotal private path", "credentials.ts": "subtotal credentials content",
    "src/.env.ts": "subtotal private settings", "debug.ts": 'const apiKey = "private-dummy-value";\nsubtotal(x);',
    "logs.ts": "const subtotal = 'Authorization: Bearer private-test-fixture';",
  });
  const blocked = await answerQuestion(snapshot, 'subtotal password="private-question"', "test", () => { throw new Error("Unexpected provider"); });
  assert.match(blocked, /did not establish an answer/);
  assert.deepEqual(reads, []);
  const answer = await answerQuestion(snapshot, "subtotal", "test", () => async (_role, payload) => {
    assert.doesNotMatch(payload, /private|credentials|debug\.ts|logs\.ts/);
    return JSON.stringify({ answer: "Located in committed files.", citations: [0] });
  });
  assert.doesNotMatch(reads.join(" "), /credentials|\.env|\.private/);
  assert.doesNotMatch(answer, /private|credentials/);
});

test("provider errors fall back to cited source and all untrusted output stays literal", async () => {
  const { snapshot } = fixture({ "fees.ts": "subtotal @billing [click](https://invalid.test)\n\n" });
  const answer = await answerQuestion(snapshot, "subtotal", "test", () => async () => { throw new Error("private transport error"); });
  assert.match(answer, /model answer was unavailable/);
  assert.doesNotMatch(answer, /private transport/);
  assert.ok(answer.includes("` subtotal @billing [click](https://invalid.test) `"));
  const modelAnswer = await answerQuestion(snapshot, "subtotal", "test", () => async () => JSON.stringify({
    answer: "Look at `subtotal`\n\n## @billing", citations: [0],
  }));
  assert.ok(modelAnswer.includes("`` Look at `subtotal`  ## @billing ``"));
  assert.equal(modelAnswer.match(/^## /gm)?.length, 1);
});

test("large files consume the scan byte budget and unsupported inventories abstain", async () => {
  const { snapshot, reads } = fixture(Object.fromEntries(Array.from({ length: 90 }, (_, i) => [`src/file-${i}.ts`, "x".repeat(48 * 1024)])));
  const answer = await answerQuestion(snapshot, "price");
  assert.equal(reads.length, 8);
  assert.match(answer, /did not establish an answer/);
  const candidate = { ...snapshot };
  delete candidate.listPaths;
  assert.match(await answerQuestion(candidate, "price"), /did not establish an answer/);
});
