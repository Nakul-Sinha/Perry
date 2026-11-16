import assert from "node:assert/strict";
import { test } from "node:test";
import { postModelJson } from "../src/provider-http.ts";
import { selectModel } from "../src/model-review.ts";

const endpoint = "https://api.openai.com/v1/responses";

test("model transport bounds streamed output and declines error pages without returning their body", async t => {
  const out = [new Response("private fixture error body", {status: 403}), new Response("ok"),
    new Response(new Uint8Array(270_000), {headers: {"content-type": "application/json"}})];
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
    return out[calls++];
  });
  for (const expected of [/usable response/, /usable response/, /transport budget/]) {
    await assert.rejects(postModelJson(endpoint, "fixture", {}), expected);
  }
  await assert.rejects(postModelJson(endpoint, "fixture", {input: "x".repeat(270_000)}), /Invalid model request/);
  assert.equal(calls, 3);
});

test("an ambiguous provider choice or invalid model ID fails before a request", () => {
  assert.equal(selectModel({}), undefined);
  assert.throws(() => selectModel({"openai-model": "fixture", "anthropic-model": "fixture"}));
  for (const bad of ["", "bad id", "suffix\n"]) assert.throws(() => selectModel({"opencode-chat-model": bad}));
});
