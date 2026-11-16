import assert from "node:assert/strict";
import test from "node:test";
import { opencodeMessage } from "../src/opencode.ts";

const message = { role: "assistant", content: '{"candidates":[]}' };
const choice = { finish_reason: "stop", message };
const send = () => opencodeMessage("fixture-paid-model", "Review the supplied source.", '{"code":"example"}', "fixture-key");

test("OpenCode sends the selected model and separates instructions from source at its fixed endpoint", async t => {
  const request = t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(url, init);
    assert.equal(req.url, "https://opencode.ai/inference/openai/v1/chat/completions");
    assert.equal(req.method, "POST");
    assert.equal(req.headers.get("authorization"), "Bearer fixture-key");
    assert.equal(req.redirect, "error");
    assert.deepEqual(await req.json(), {
      model: "fixture-paid-model", max_tokens: 3000, stream: false,
      messages: [{ role: "system", content: "Review the supplied source." }, { role: "user", content: '{"code":"example"}' }],
    });
    return Response.json({ choices: [{ ...choice, message: { ...message, tool_calls: [], reasoning_content: "private reasoning" } }] });
  });
  assert.equal(await send(), message.content);
  assert.equal(request.mock.callCount(), 1);
});

test("OpenCode rejects ambiguous completions, tool calls, refusals and byte-limit violations", async t => {
  for (const value of [
    null, { choices: [] }, { error: { message: "private error detail" }, choices: [choice] },
    { choices: [choice, choice] }, { choices: [{ ...choice, finish_reason: "length" }] },
    { choices: [{ ...choice, finish_reason: "content_filter" }] }, { choices: [{ ...choice, finish_reason: "tool_calls" }] },
    ...[
      { ...message, role: "user" }, { ...message, refusal: "private refusal" },
      { ...message, tool_calls: [{ id: "private call" }] }, { ...message, function_call: { name: "private" } },
      { ...message, content: [{ type: "text", text: "partial" }] }, { ...message, content: " " },
      { ...message, content: "é".repeat(8193) },
    ].map(message => ({ choices: [{ ...choice, message }] })),
  ]) {
    const request = t.mock.method(globalThis, "fetch", async () => Response.json(value));
    await assert.rejects(send(), { message: "OpenCode returned an incomplete or unsupported response." });
    assert.equal(request.mock.callCount(), 1);
    request.mock.restore();
  }
});

test("an ineligible OpenCode request stops after its single 403 response", async t => {
  const request = t.mock.method(globalThis, "fetch", async () => Response.json({ error: "private account detail" }, { status: 403 }));
  await assert.rejects(send(), error => error instanceof Error && !error.message.includes("private account detail"));
  assert.equal(request.mock.callCount(), 1);
});
