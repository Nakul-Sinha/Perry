import assert from "node:assert/strict";
import { test } from "node:test";
import { anthropicBackend, investigate, type ContextFile } from "../src/model-review.ts";
import type { Finding } from "../src/contracts.ts";

const oldSha = "1".repeat(40);
const newSha = "2".repeat(40);
const source: ContextFile[] = [
  { path: "tax.ts", ref: "merge_base", sha: oldSha, changed: true, text: "export const tax = total => total * .05;\n" },
  { path: "tax.ts", ref: "head", sha: newSha, changed: true, text: "export const tax = total => total * .5;\n" },
  { path: "invoice.ts", ref: "head", sha: newSha, changed: false, text: "const due = total + tax(total);\n" },
  { path: "plan.md", ref: "base", sha: oldSha, changed: false, text: "Apply a five percent charge to the subtotal." },
];
const cause = { file: 1, line: 1, quote: source[1]!.text.trim() };
const prior = { file: 0, line: 1, quote: source[0]!.text.trim() };
const item = {
  title: "Invoice tax increases tenfold", severity: "high", cause, prior,
  trigger: "Calculate the tax on a positive invoice subtotal.", impact: "The invoice applies a fifty percent charge.",
  fix: "Use a multiplier of 0.05.",
};
const accepted = { index: 0, verdict: "accept", reason: "The approved plan still requires five percent and the invoice caller applies the full result.", cause, prior };
const draft = (candidates: unknown[]) => JSON.stringify({ candidates, incomplete: false });
const verified = (...decisions: unknown[]) => JSON.stringify({ decisions });

test("both model passes receive the same independent check outcomes", async () => {
  const evidence = ["Pinned base passed.", "Pinned head failed."];
  const roles: string[] = [];
  const review = await investigate(source, async (role, payload) => {
    roles.push(role);
    assert.deepEqual(JSON.parse(payload).checksRun, evidence);
    return role === "investigator" ? draft([item]) : verified(accepted);
  }, evidence);
  assert.deepEqual(roles, ["investigator", "verifier"]);
  assert.equal(review.findings.length, 1);
});

test("the Anthropic SDK sends independent requests to the selected model and rejects truncated replies", async t => {
  // This process uses an in-process HTTP transport and a public fixture value.
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    assert.equal(request.url, "https://api.anthropic.com/v1/messages");
    assert.equal(request.headers.get("authorization"), "Bearer fixture-access");
    const body = await request.json();
    assert.equal(body.messages.length, 1);
    assert.equal(body.model, "fixture-model");
    assert.equal(body.max_tokens, 3000);
    const truncated = body.messages[0].content === "truncated";
    return Response.json({ stop_reason: truncated ? "max_tokens" : "end_turn", content: [{ type: "text", text: draft([]) }] });
  });
  // Pass the fixture through the factory seam so installed user settings stay untouched.
  const call = anthropicBackend("fixture-model", () => "fixture-access");
  assert.equal(await call("investigator", "fixture"), draft([]));
  await assert.rejects(call("verifier", "truncated"), /incomplete/);
});

test("the fresh verifier independently cites both source versions before a finding is published", async () => {
  const calls: string[] = [];
  const review = await investigate(source, async (role, payload) => {
    calls.push(role);
    const input = JSON.parse(payload);
    assert.equal(input.files[2].path, "invoice.ts");
    assert.equal(input.files[3].ref, "base");
    if (role === "investigator") return draft([item]);
    assert.deepEqual(input.claims, [{ index: 0, title: item.title, trigger: item.trigger, impact: item.impact }]);
    return verified(accepted);
  });
  assert.deepEqual(calls, ["investigator", "verifier"]);
  assert.deepEqual(review.limitations, []);
  assert.equal(review.findings.length, 1);
  assert.deepEqual(review.findings[0]?.evidence, { path: "tax.ts", line: 1, sha: newSha });
  assert.ok(review.findings[0]?.impact.includes(oldSha));
});

test("a refuted candidate stays out of the findings and an unresolved claim leaves a gap", async () => {
  for (const verdict of ["reject", "unresolved"]) {
    const review = await investigate(source, async role => role === "investigator" ? draft([item]) : verified({
      index: 0, verdict, reason: "Evidence is inconsistent with the claim.",
    }));
    assert.deepEqual(review.findings, []);
    assert.equal(review.limitations.length, verdict === "reject" ? 0 : 1);
  }
});

test("invalid lines, quotations, unchanged sources and unrelated base evidence cannot support a finding", async () => {
  for (const bad of [
    { ...item, cause: { ...cause, line: 2 } },
    { ...item, cause: { ...cause, quote: "fake" } },
    { ...item, cause: { ...cause, file: 2, quote: source[2]!.text.trim() } },
    { ...item, prior: { ...cause } }, { ...item, prior: { file: 3, line: 1, quote: source[3]!.text } },
  ]) {
    const review = await investigate(source, async role => {
      assert.equal(role, "investigator");
      return draft([bad]);
    });
    assert.equal(review.findings.length, 0);
    assert.ok(review.limitations.length);
  }
  const unmodified = source.map((file, i) => i === 0 ? { ...file, text: file.text + cause.quote } : file);
  assert.deepEqual((await investigate(unmodified, async () => draft([item]))).findings, []);
});

test("malformed, duplicate, incomplete or nonexistent verifier decisions suppress publication", async () => {
  for (const reply of [
    "", "{", verified(), verified(accepted, accepted), verified({ ...accepted, index: 2 }),
    verified({ ...accepted, prior: { ...prior, line: 4 } }), verified({ ...accepted, cause: prior }),
  ]) {
    const review = await investigate(source, async role => role === "investigator" ? draft([item]) : reply);
    assert.equal(review.findings.length, 0);
    assert.ok(review.limitations.length);
  }
});

test("provider failures and truncated JSON produce a bounded, redacted limitation", async () => {
  for (const failingStage of ["investigator", "verifier"]) {
    let calls = 0;
    const review = await investigate(source, async role => {
      calls++;
      if (role === failingStage) throw new Error("private response text");
      return draft([item]);
    });
    assert.equal(calls, failingStage === "investigator" ? 1 : 2);
    assert.deepEqual(review.findings, []);
    assert.ok(review.limitations[0]?.includes(failingStage));
    assert.doesNotMatch(JSON.stringify(review), /private response text/);
  }
  for (const reply of ["refusal", '{"candidates":[', " ".repeat(17 * 1024)]) {
    const result = await investigate(source, async () => reply);
    assert.ok(result.limitations.length && !result.findings.length);
  }
});

test("budgets bound supplied source, model output and number of calls", async () => {
  for (const files of [
    [...source, source[0]!], [], [{ ...source[0]!, text: "a".repeat(100 * 1024) }],
    [source[0]!, { ...source[1]!, sha: "untrusted-head" }], [source[1]!],
  ]) {
    let calls = 0;
    const review = await investigate(files, async () => { calls++; return draft([]); });
    assert.equal(calls, 0);
    assert.ok(review.limitations.length);
  }
  let calls = 0;
  const review = await investigate(source, async (role, payload) => {
    calls++;
    if (role === "investigator") return draft(Array(7).fill(item));
    assert.equal(JSON.parse(payload).claims.length, 4);
    return verified(...[0, 1, 2, 3].map(index => ({ ...accepted, index })));
  });
  assert.equal(calls, 2);
  assert.equal(review.findings.length, 1);
  assert.ok(review.limitations.some(text => text.includes("unresolved")));
});

test("corroboration requires the exact static import and independent model witnesses", async () => {
  const files: ContextFile[] = [
    { path: "prices.mjs", changed: true, ref: "merge_base", sha: oldSha, text: "export const price = 10, tax = .05;" },
    { path: "prices.mjs", changed: true, ref: "head", sha: newSha, text: "export const cost = 10, tax = .5;" },
    { path: "invoice.mjs", changed: false, ref: "head", sha: newSha, text: "import { price } from './prices.mjs';" },
  ];
  const before = { file: 0, line: 1, quote: files[0]!.text };
  const after = { file: 1, line: 1, quote: files[1]!.text };
  const importer = { file: 2, line: 1, quote: files[2]!.text };
  const binding = { name: "price", importer };
  const issue: Finding = {
    id: "esm-export:prices.mjs:price", title: "Missing named export: price", severity: "medium",
    trigger: "Load invoice.mjs.", impact: "The import cannot link.", fix: "Restore price.",
    evidence: { path: "invoice.mjs", line: 1, sha: newSha },
  };
  const linking = { ...item, title: issue.title, trigger: issue.trigger, impact: issue.impact, fix: issue.fix,
    cause: after, prior: before, missingExport: binding };
  const tax = { ...item, cause: after, prior: before };
  const decision = { ...accepted, cause: after, prior: before, missingExport: binding };
  const result = await investigate(files, async role => role === "investigator" ? draft([linking, tax])
    : verified(decision, { ...accepted, cause: after, prior: before, index: 1 }), undefined, [issue]);
  assert.deepEqual(result.findings.map(finding => finding.id), [issue.id, "model:prices.mjs:1"]);
  assert.equal(result.findings[1]?.title, tax.title);

  for (const [staticIssue, secondWitness] of [
    [issue, undefined], [issue, { name: "tax", importer }],
    [issue, { name: "price", importer: { ...importer, quote: "invented" } }],
    [{ ...issue, evidence: { ...issue.evidence, sha: oldSha } }, binding],
    [{ ...issue, evidence: { ...issue.evidence, line: 2 } }, binding],
  ] as const) {
    const unconfirmed = await investigate(files, async role => role === "investigator" ? draft([linking])
      : verified({ ...decision, missingExport: secondWitness }), undefined, [staticIssue]);
    assert.equal(unconfirmed.findings[0]?.id, "model:prices.mjs:1");
  }
});
