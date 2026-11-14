import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(new URL("../../../tools/fixtures/review.ts", import.meta.url));
const transport = new URL("./support/model-transport.mjs", import.meta.url).href;

for (const scenario of ["empty-cart", "cart-refactor", "unchanged-consumer"]) {
  test("model review CLI with simulated Anthropic transport: " + scenario, () => {
    const output = execFileSync(process.execPath, [fixture, scenario, "--anthropic-model", "fixture-model"], {
      encoding: "utf8", timeout: 60_000,
      env: { ...process.env, NODE_OPTIONS: "--import=" + transport, ANTHROPIC_API_KEY: "fixture-access" },
    });
    assert.doesNotMatch(output, /within the review budget|API access is unavailable/);
    if (scenario === "empty-cart") {
      assert.match(output, /DO NOT MERGE/);
      assert.match(output, /Empty cart throws/);
      assert.match(output, /cart\.mjs:1/);
    } else if (scenario === "unchanged-consumer") {
      assert.match(output, /DO NOT MERGE/);
      assert.match(output, /Removed export breaks invoice/);
      assert.match(output, /total\.mjs:1/);
    } else {
      assert.match(output, /HOLD/);
      assert.match(output, /No verified bugs/);
    }
  });
}
