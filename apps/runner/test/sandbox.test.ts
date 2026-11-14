import assert from "node:assert/strict";
import test from "node:test";
import { runSandboxCheck } from "../src/sandbox.ts";

const image = "docker.io/library/node@sha256:" + "1".repeat(64);
const source = "import test from 'node:test'; test('arithmetic', () => {});";

test("rejects non-pinned or non-official images before contacting the engine", async () => {
  for (const value of ["node:24", "docker.io/library/node:24", image + "\n", image + ":24", image.replace("library", "sample")]) {
    assert.equal((await runSandboxCheck(source, value)).status, "unavailable");
  }
});

test("rejects oversized, empty and unbounded checks before starting a container", async () => {
  for (const text of ["  ", "a".repeat(128 * 1024 + 1)]) {
    assert.equal((await runSandboxCheck(text, image)).status, "unavailable");
  }
  for (const deadline of [10, NaN, Infinity, 500.5, 30001]) {
    assert.equal((await runSandboxCheck(source, image, deadline)).status, "unavailable");
  }
});

test("unsupported hosts decline checks before invoking the engine", {
  skip: process.platform === "linux" && process.getuid?.() !== 0,
}, async () => {
  const result = await runSandboxCheck(source, image);
  assert.equal(result.status, "unavailable");
  assert.match(result.detail, /non-root user on Linux/);
});
