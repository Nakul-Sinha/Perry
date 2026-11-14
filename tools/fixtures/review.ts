import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { comparisons, manifest } from "./comparisons.ts";

const scenario = process.argv[2] ?? "broken";
const names = ["broken", "clean", "unsupported", "missing", ...Object.keys(comparisons)];
if (scenario === "--list" && process.argv.length === 3) {
  console.log(names.join("\n"));
  process.exit(0);
}
const modelArgs = process.argv.slice(3);
if (!names.includes(scenario) || (modelArgs.length && (modelArgs.length !== 2 || modelArgs[0] !== "--anthropic-model" || !modelArgs[1]))) {
  console.error("Usage: pnpm review:fixture [case] [--anthropic-model MODEL_ID]. Use --list to see case names.");
  process.exit(2);
}

const dir = mkdtempSync(join(tmpdir(), "perry-local-review-"));
const cli = fileURLToPath(new URL("../../apps/runner/src/index.ts", import.meta.url));
// Use only the fixture's Git configuration, including on developer machines
// with global hooks, signing, filters or a different default branch.
const gitEnv = {
  PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_DATE: "2025-01-10T12:00:00Z", GIT_COMMITTER_DATE: "2025-01-10T12:00:00Z",
};

function git(...args: string[]) {
  const proc = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env: gitEnv, windowsHide: true });
  if (proc.status !== 0) throw new Error("Fixture Git command failed: " + args[0]);
  return proc.stdout.trim();
}
function applyFiles(files: Record<string, string | null>) {
  for (const [name, body] of Object.entries(files)) {
    const path = join(dir, name);
    if (body === null) rmSync(path);
    else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, body);
    }
  }
}

try {
  git("init", "-q", "--template=", "-b", "main");
  git("config", "user.name", "Perry Fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "core.autocrlf", "false");
  const comparison = comparisons[scenario];
  applyFiles(comparison?.base ?? {
    "package.json": manifest({ check: "npm run lint", lint: "node --check index.mjs" }),
    "index.mjs": "export const total = 1;\n",
    "totals.mjs": "export const total = 1;\n",
    "consumer.mjs": "import { total } from './totals.mjs';\nexport const amount = total;\n",
  });
  git("add", ".");
  git("commit", "-qm", "add package checks");
  const base = git("rev-parse", "HEAD");

  if (comparison) {
    applyFiles(comparison.edits);
  } else if (scenario === "unsupported") {
    writeFileSync(join(dir, "design.md"), "Keep the existing package checks.\n");
  } else if (scenario === "clean") {
    writeFileSync(join(dir, "package.json"), manifest({ check: "npm run syntax", syntax: "node --check index.mjs" }));
    writeFileSync(join(dir, "index.mjs"), "export const total = 2;\n");
    writeFileSync(join(dir, "consumer.mjs"), "import { total as subtotal } from './totals.mjs';\nexport const amount = subtotal;\n");
  } else {
    writeFileSync(join(dir, "package.json"), manifest({ check: "npm run lint" }));
    writeFileSync(join(dir, "index.mjs"), "export const total = ;\n");
    writeFileSync(join(dir, "consumer.mjs"), "import { subtotal } from './totals.mjs';\nexport const amount = subtotal;\n");
  }
  git("add", ".");
  git("commit", "-qm", "revise package checks");
  const head = scenario === "missing" ? "0".repeat(base.length) : git("rev-parse", "HEAD");
  // A dirty repair must have no effect on the reported bugs at head.
  if (!comparison) {
    writeFileSync(join(dir, "package.json"), manifest({ check: "node --check index.mjs" }));
    writeFileSync(join(dir, "index.mjs"), "export const total = 3;\n");
  }
  const proc = spawnSync(process.execPath, [cli, "review", "--repo", dir, "--base", base, "--head", head, ...modelArgs], {
    stdio: "inherit", windowsHide: true,
  });
  process.exitCode = proc.status ?? 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
