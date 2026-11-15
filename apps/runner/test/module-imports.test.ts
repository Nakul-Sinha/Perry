import assert from "node:assert/strict";
import { test } from "node:test";
import type { BlobRead, Snapshot } from "../src/contracts.ts";
import { inspectImports } from "../src/module-imports.ts";

type Files = Record<string, string | BlobRead>;
const path = "src/main.mjs";
const target = "src/library.mjs";
const use = "import { price as amount } from './library.mjs';";
const valid = "export const price = 10;";
const missing = "export const label = 'Price';";

function review(before: Files, after: Files, changed = [path]) {
  const reads: string[] = [];
  const snapshot: Snapshot = {
    base: "1".repeat(40), merge_base: "2".repeat(40), head: "3".repeat(40),
    changes: changed.map(path => ({
      path, status: Object.hasOwn(before, path) ? (Object.hasOwn(after, path) ? "modified" : "deleted") : "added",
    })),
    listPaths: async ref => {
      assert.equal(ref, "head");
      return Object.keys(after);
    },
    read: async (rev, path) => {
      assert.notEqual(rev, "base");
      reads.push(rev + ":" + path);
      const files = rev === "head" ? after : before;
      const value = files[path];
      if (typeof value === "string") return { kind: "text", text: value };
      return value ?? { kind: "missing" };
    },
  };
  return { run: () => inspectImports(snapshot), reads, snapshot };
}

test("an added named import is verified against an unchanged provider", async () => {
  const { run, reads } = review({ [path]: "", [target]: missing }, { [path]: "\n" + use, [target]: missing });
  const result = await run();
  assert.equal(result.findings.length, 1);
  const finding = result.findings[0]!;
  assert.deepEqual(finding.evidence, { sha: "3".repeat(40), path, line: 2 });
  assert.match(finding.impact, /src\/library\.mjs has no named export price/);
  assert.match(finding.fix, /named export/);
  assert.ok(reads.includes("head:" + target));
});

test("an old import is a regression only when the base provider supported it", async () => {
  for (const [beforeProvider, count] of [[valid, 1], [missing, 0], ["export * from './more.mjs';", 0]] as const) {
    const { run, reads } = review(
      { [path]: use, [target]: beforeProvider }, { [path]: use + "\n// Changed", [target]: missing }, [path, target],
    );
    assert.equal((await run()).findings.length, count);
    assert.ok(reads.includes("merge_base:" + target));
  }
  const quoted = "import { 'price' as price } from './library.mjs';";
  assert.deepEqual((await review({ [path]: quoted, [target]: missing }, { [path]: use, [target]: missing }).run()).findings, []);
});

test("simple exported aliases and functions link successfully", async () => {
  for (const provider of [valid, "const p = 1; export { p as price };", "export function price() {}", "export class price {}"]) {
    assert.deepEqual((await review({}, { [path]: use, [target]: provider }).run()).findings, []);
  }
});

test("ambiguous export sets, missing sources and bad syntax leave explicit gaps", async () => {
  for (const provider of [
    "export * from './other.mjs';", "export { label } from './other.mjs';", "export const { label } = {};",
    "import { cost } from './other.mjs'; export { cost as label };",
    "export let broken = ;", { kind: "unavailable", reason: "Symlink" } as BlobRead, { kind: "missing" } as BlobRead,
    " ".repeat(65537),
  ]) {
    const result = await review({}, { [path]: use, [target]: provider }).run();
    assert.deepEqual(result.findings, []);
    assert.ok(result.limitations.length >= 2);
  }
});

test("out-of-repo, generated, ambiguous and third-party specifiers never trigger a source read", async () => {
  for (const spec of ["../../outside.mjs", "./node_modules/code.mjs", "./generated/file.mjs", "../dist/build.mjs",
    "./nested/../library.mjs", "./section%2Flibrary.mjs", "./library.mjs?q", "dependency", "/absolute.mjs"]) {
    const { run, reads } = review({}, { [path]: "import { price } from '" + spec + "';" });
    assert.deepEqual((await run()).findings, []);
    assert.deepEqual(reads, ["head:" + path]);
  }
});

test("cross-directory imports within the repo use pinned literal paths", async () => {
  const consumer = "src/features/main.mjs";
  const outcome = await review({}, { [consumer]: use.replace("./library.mjs", "../library.mjs"), [target]: missing }, [consumer]).run();
  assert.equal(outcome.findings.length, 1);
  assert.match(outcome.findings[0]!.impact, /src\/library\.mjs/);
});

test("two added consumers of the same missing export yield one root cause", async () => {
  const other = "src/pricing.mjs";
  const { run } = review({}, { [path]: use, [other]: use, [target]: missing }, [path, other]);
  assert.equal((await run()).findings.length, 1);
});

test("an added consumer with a possible rename is not called a new regression", async () => {
  const original = "src/previous-name.js";
  const result = await review({ [original]: use, [target]: missing }, { [path]: use, [target]: missing }, [path, original]).run();
  assert.deepEqual(result.findings, []);
  assert.ok(result.limitations.some(reason => reason.includes("renamed")));
});

test("an unusual base specifier may alias the new import", async () => {
  const oldImport = use.replace("./library.mjs", "./%6cibrary.mjs");
  const result = await review({ [path]: oldImport, [target]: missing }, { [path]: use, [target]: missing }).run();
  assert.deepEqual(result.findings, []);
});

test("a prior direct re-export may already have failed module linking", async () => {
  const original = "export { price } from './library.mjs';";
  const result = await review({ [path]: original, [target]: missing }, { [path]: use, [target]: missing }).run();
  assert.deepEqual(result.findings, []);
});

test("a renamed export breaks an unchanged caller at the pinned head import", async () => {
  const consumer = "\n" + use;
  const { run, reads } = review({ [path]: consumer, [target]: valid }, { [path]: consumer, [target]: missing }, [target]);
  const result = await run();
  assert.equal(result.findings.length, 1);
  assert.deepEqual(result.findings[0]?.evidence, { sha: "3".repeat(40), path, line: 2 });
  assert.match(result.findings[0]!.impact, /src\/library\.mjs has no named export price/);
  assert.ok(result.findings[0]!.impact.includes("merge base " + "2".repeat(40)));
  assert.deepEqual(reads, ["head:" + target, "merge_base:" + target, "head:" + path]);
});

test("compatible exports, pre-existing broken imports, and different providers stay quiet", async () => {
  const compatible = "const n = 2; export { n as price };";
  for (const [baseline, head, importLine] of [
    [valid, compatible, use],
    ["export const obsolete = 1;", missing, use],
    [valid, missing, use.replace("library", "another")],
    [valid, "export * from './fallback.mjs';", use],
    ["export * from './fallback.mjs';", missing, use],
  ] as const) {
    const old = { [path]: importLine, [target]: baseline };
    const { run, reads } = review(old, { ...old, [target]: head }, [target]);
    assert.equal((await run()).findings.length, 0);
    if (head === compatible) assert.ok(!reads.includes("head:" + path), "A compatible edit needs no reverse scan.");
  }
});

test("changed and unchanged callers of one removed export share one root cause", async () => {
  const also = "src/also.mjs";
  const before = { [path]: use, [also]: use, [target]: valid };
  const result = await review(before, { ...before, [path]: "// changed\n" + use, [target]: missing }, [target, path]).run();
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]?.evidence.path, path);
});

test("an unavailable inventory records a gap without discarding changed caller findings", async () => {
  const before = { [path]: use, [target]: valid };
  const { snapshot, run } = review(before, { ...before, [path]: "\n" + use, [target]: missing }, [path, target]);
  for (const mode of ["unavailable", "throws"]) {
    if (mode === "unavailable") delete snapshot.listPaths;
    else snapshot.listPaths = async () => { throw new Error("Incomplete inventory"); };
    const result = await run();
    assert.equal(result.findings.length, 1);
    assert.ok(result.limitations.some(line => line.includes("head inventory")));
  }
});

test("reverse discovery respects source exclusions and bounds unchanged file reads", async () => {
  const code = Object.fromEntries(Array.from({ length: 40 }, (_, i) => ["src/c" + i + ".mjs", "export {};"]));
  const before = { [target]: valid, "dist/bundle.mjs": use, ...code, [path]: use };
  const { run, reads } = review(before, { ...before, [target]: missing }, [target]);
  const result = await run();
  assert.equal(result.findings.length, 0);
  assert.ok(result.limitations.some(line => line.includes("32 eligible modules")));
  assert.equal(reads.length, 2 + 32);
  assert.ok(!reads.some(path => path.includes("dist/")));
});
