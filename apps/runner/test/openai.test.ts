import assert from "node:assert/strict";
import test from "node:test";
import { openaiMessage } from "../src/openai.ts";

const key = "fixture-access";
const model = "fixture-model";
const instructions = "Return a review as JSON.";
const payload = '{"files":[]}';
const text = (value: string) => ({ type: "output_text", text: value });
const message = (...content: unknown[]) => ({ type: "message", role: "assistant", status: "completed", content });
const completed = (...output: unknown[]) => ({ status: "completed", output });
const send = () => openaiMessage(model, instructions, payload, key);

test("sends a single stateless Responses request with no tools and returns only the final text", async t => {
  const request = t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(url, init);
    assert.equal(req.url, "https://api.openai.com/v1/responses");
    assert.equal(req.method, "POST");
    assert.equal(req.headers.get("authorization"), "Bearer " + key);
    assert.equal(req.redirect, "error");
    assert.deepEqual(await req.json(), { model, input: payload, instructions, store: false, max_output_tokens: 3000, tools: [] });
    return Response.json(completed(
      { type: "reasoning", id: "r", summary: [], encrypted_content: "opaque" },
      { ...message(text("I will inspect the source.")), phase: "commentary" },
      { type: "reasoning", status: "completed", summary: [] },
      { ...message(text('{"findings":'), text("[]}")), phase: "final_answer" },
    ));
  });
  assert.equal(await send(), '{"findings":[]}');
  assert.equal(request.mock.callCount(), 1);
});

test("rejects incomplete, refused and ambiguous output without leaking provider content", async t => {
  const answer = message(text("{}"));
  const refusal = { type: "refusal", refusal: "private refusal detail" };
  for (const value of [
    { ...completed(answer), status: "incomplete" }, { ...completed(answer), error: { message: "private error detail" } },
    { ...completed(answer), incomplete_details: { reason: "max_output_tokens" } }, { output_text: "{}" },
    completed({ type: "reasoning", status: "incomplete" }, answer), completed({ ...answer, status: "in_progress" }),
    completed({ ...answer, role: "user" }), completed({ ...answer, phase: "unknown" }),
    completed({ ...answer, phase: "commentary" }), completed(message(text("{}"), refusal)),
    completed({ ...message(refusal), phase: "commentary" }, answer), completed(answer, answer),
    completed({ type: "function_call", arguments: "private arguments" }, answer), completed(message(text("   "))),
    completed({ type: "reasoning" }), completed(message(text("é".repeat(8193)))),
  ]) {
    const request = t.mock.method(globalThis, "fetch", async () => Response.json(value));
    await assert.rejects(send(), { message: "OpenAI returned an incomplete or unsupported response." });
    assert.equal(request.mock.callCount(), 1);
    request.mock.restore();
  }
});

test("accepts an unphased completed message at the decoded byte limit", async t => {
  const full = "é".repeat(8192);
  t.mock.method(globalThis, "fetch", async () => Response.json(completed(message(text(full)))));
  assert.equal(await send(), full);
});
