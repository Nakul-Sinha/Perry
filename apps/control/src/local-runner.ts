import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { MentionRequest } from "./intake.ts";
import type { Bodies, Refs } from "./worker.ts";

// Both workspace packages are distributed together. Use the matching source
// or built entry point, always outside the repository being reviewed.
const runner = fileURLToPath(new URL(import.meta.url.endsWith(".ts")
  ? "../../runner/src/index.ts" : "../../runner/dist/index.js", import.meta.url));

export async function runLocal(repo: string, r: MentionRequest, refs: Refs, signal: AbortSignal, model?: string): Promise<Bodies> {
  const args = [runner, r.kind === "review" ? "review" : "ask", "--json", "--repo", repo, "--base", refs.base, "--head", refs.head];
  if (r.kind === "question") args.push("--question=" + r.text);
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot };
  if (model) {
    args.push("--anthropic-model", model);
    env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  }
  const body = await new Promise<string>((resolve, reject) => {
    execFile(process.execPath, args, { env, signal, timeout: 150_000, maxBuffer: 1024 * 1024, windowsHide: true },
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
    return {summary: report.summary, findings: report.findings};
  }
  throw new Error("Invalid local result.");
}
