import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(new URL("../../../tools/fixtures/review.ts", import.meta.url));
const transport = new URL("./support/model-transport.mjs", import.meta.url).href;

for (const scenario of ["empty-cart", "cart-refactor", "unchanged-consumer"]) {
  test("model review CLI with simulated Anthropic transport: " + scenario, () => {
    const output = execFileSync(process.execPath, [fixture, scenario, "--anthropic-model", "fixture-model"], {
      encoding: "utf8", timeout: 60_000,
      env: {PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
        NODE_OPTIONS: "--import=" + transport, ANTHROPIC_API_KEY: "fixture-access",
        ANTHROPIC_CUSTOM_HEADERS: "Authorization: Bearer other-fixture\nx-api-key: other-fixture"},
    });
    assert.doesNotMatch(output, /within the review budget|API access is unavailable/);
    if (scenario === "empty-cart") {
      assert.match(output, /DO NOT MERGE/);
      assert.match(output, /Empty cart throws/);
      assert.match(output, /cart\.mjs:1/);
    } else if (scenario === "unchanged-consumer") {
      assert.match(output, /DO NOT MERGE/);
      assert.match(output, /1 material finding,/);
      assert.equal((output.match(/^\d+\. \*\*\w+\*\*/gm) ?? []).length, 1);
      assert.match(output, /Missing named export: total/);
      const head = /Head `([a-f0-9]{40,64})`/.exec(output)![1];
      assert.ok(output.includes("Static evidence: `invoice.mjs:1` at `" + head + "`"));
      assert.ok(output.includes("Independently verified provider: `total.mjs:1` at `" + head + "`"));
    } else {
      assert.match(output, /HOLD/);
      assert.match(output, /No verified bugs/);
    }
  });
}

for (const [provider, key, flag] of [
  ["openai", "OPENAI_API_KEY", "--openai-model"],
  ["opencode", "OPENCODE_API_KEY", "--opencode-chat-model"],
] as const) {
  test(provider + " reviews and answers through the selected simulated endpoint", t => {
    const env = {PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
      NODE_OPTIONS: "--import=" + transport, PERRY_TEST_ROUTE: provider, [key]: "fixture-access"};
    const opts = {env, encoding: "utf8" as const, timeout: 60_000, windowsHide: true};
    const report = execFileSync(process.execPath, [fixture, "empty-cart", flag, "fixture-model"], opts);
    assert.match(report, /Empty cart throws/);
    assert.match(report, /DO NOT MERGE/);
    const root = mkdtempSync(join(tmpdir(), "perry-byok-"));
    t.after(() => rmSync(root, {recursive: true, force: true}));
    const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], {...opts, env: {
      PATH: env.PATH, SystemRoot: env.SystemRoot, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    }}).trim();
    git("init", "--template=", "-q");
    writeFileSync(join(root, "tax.mjs"), "export const TAX_RATE = 0.05;\n");
    git("add", "tax.mjs");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "add tax module");
    const sha = git("rev-parse", "HEAD");
    const main = fileURLToPath(new URL("../src/index.ts", import.meta.url));
    const answer = execFileSync(process.execPath, [main, "ask", "--repo", root, "--base", sha, "--head", sha,
      "--question", "Where is TAX_RATE?", flag, "fixture-model"], opts);
    assert.match(answer, /tax rate is five percent/);
    assert.match(answer, /tax\.mjs:1/);
    assert.ok(answer.includes(sha));
  });
}
