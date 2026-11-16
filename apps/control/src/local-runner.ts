import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { MentionRequest } from "./intake.ts";
import type { Bodies, Refs } from "./worker.ts";

// Both workspace packages are distributed together. Use the matching source
// or built entry point, always outside the repository being reviewed.
const runner = fileURLToPath(new URL(import.meta.url.endsWith(".ts")
  ? "../../runner/src/index.ts" : "../../runner/dist/index.js", import.meta.url));

const providers = {
  anthropic: {setting: "PERRY_ANTHROPIC_MODEL", flag: "--anthropic-model", key: "ANTHROPIC_API_KEY"},
  openai: {setting: "PERRY_OPENAI_MODEL", flag: "--openai-model", key: "OPENAI_API_KEY"},
  "opencode-chat": {setting: "PERRY_OPENCODE_CHAT_MODEL", flag: "--opencode-chat-model", key: "OPENCODE_API_KEY"},
} as const;

export interface ApprovedModel {provider: keyof typeof providers; model: string}

export function approvedModel(env: NodeJS.ProcessEnv): ApprovedModel | undefined {
  const selected = (Object.keys(providers) as ApprovedModel["provider"][])
    .filter(provider => env[providers[provider].setting] !== undefined);
  if (!selected.length) return;
  if (selected.length !== 1) {
    throw new Error("Configure PERRY_ANTHROPIC_MODEL, PERRY_OPENAI_MODEL or PERRY_OPENCODE_CHAT_MODEL with exactly one model.");
  }
  const provider = selected[0]!;
  const model = env[providers[provider].setting]!;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(model) || model.trim() !== model) {
    throw new Error("Configure " + providers[provider].setting + " with an explicit model ID.");
  }
  return {provider, model};
}

export interface ApprovedCheck {testPath: string; modulePath?: string}

export function approvedCheck(testPath?: string, modulePath?: string): ApprovedCheck | undefined {
  if (testPath === undefined && modulePath === undefined) return;
  const valid = (path: string) => path.length <= 200 && !/[^a-zA-Z0-9_./-]/.test(path)
    && path.split("/").every(part => /^[a-zA-Z0-9_]/.test(part));
  if (!testPath?.endsWith(".test.mjs") || !valid(testPath) || (modulePath !== undefined
    && (!valid(modulePath) || !modulePath.endsWith(".mjs") || modulePath === testPath
      || modulePath.startsWith(testPath + "/") || testPath.startsWith(modulePath + "/")))) {
    throw new Error("Configure PERRY_TEST_PATH and optional PERRY_TEST_MODULE with distinct repository-relative ES module paths.");
  }
  return modulePath ? {testPath, modulePath} : {testPath};
}

export async function runLocal(repo: string, r: MentionRequest, refs: Refs, signal: AbortSignal,
  model?: string | ApprovedModel, check?: ApprovedCheck,
  runtime: {env: NodeJS.ProcessEnv; execute: typeof execFile} = {env: process.env, execute: execFile}): Promise<Bodies> {
  const args = [runner, r.kind === "review" ? "review" : "ask", "--json", "--repo", repo, "--base", refs.base, "--head", refs.head];
  if (r.kind === "question") args.push("--question=" + r.text);
  const env: NodeJS.ProcessEnv = { PATH: runtime.env.PATH, SystemRoot: runtime.env.SystemRoot };
  const selected = r.kind === "review" && refs.sameRepository === true ? check : undefined;
  if (selected) {
    args.push("--test=" + selected.testPath);
    if (selected.modulePath) args.push("--module=" + selected.modulePath);
    // Rootless Podman locates the user's local engine through these directories.
    // The container gets its own empty environment and no host mounts.
    for (const name of ["HOME", "USER", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]) {
      if (runtime.env[name]) env[name] = runtime.env[name];
    }
  }
  if (model) {
    const selectedModel = typeof model === "string" ? approvedModel({PERRY_ANTHROPIC_MODEL: model})! : model;
    const provider = providers[selectedModel.provider];
    args.push(provider.flag, selectedModel.model);
    if (runtime.env[provider.key]) env[provider.key] = runtime.env[provider.key];
  }
  const body = await new Promise<string>((resolve, reject) => {
    runtime.execute(process.execPath, args, { env, signal, timeout: selected ? 250_000 : 150_000, maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        if (error && error.code !== 1) reject(new Error("Local runner unavailable."));
        else resolve(stdout);
      });
  });
  const report = JSON.parse(body);
  if (r.kind === "question" && typeof report?.answer === "string") return { answer: report.answer };
  if (r.kind === "review" && typeof report?.summary === "string" && typeof report.findings === "string"
    && Number.isInteger(report.score) && report.score >= 0 && report.score <= 10
    && ["HOLD", "DO NOT MERGE"].includes(report.recommendation)) {
    const limitation = check && !selected ? "\n\nThe configured runtime check was skipped because the PR head could not be verified as belonging to this repository." : "";
    return {summary: report.summary, findings: report.findings + limitation};
  }
  throw new Error("Invalid local result.");
}
