import type { MentionRequest } from "./intake.ts";
import type { UsageStore } from "./usage-store.ts";
import type { Bodies, Refs } from "./worker.ts";

export function dailyAssessmentLimit(value: string | undefined): number | undefined {
  if (value === undefined) return;
  if (!/^[1-9]\d{0,6}$/.test(value) || Number(value) > 1_000_000) {
    throw new Error("Configure PERRY_DAILY_ASSESSMENT_LIMIT as an integer from 1 to 1000000, or leave it unset.");
  }
  return Number(value);
}

export async function assessmentAdmission(
  usage: Pick<UsageStore, "reserve">, request: MentionRequest, refs: Refs,
  limit: number | undefined, signal: AbortSignal,
): Promise<Bodies | null> {
  signal.throwIfAborted();
  if (limit === undefined) return null;
  const identity = JSON.stringify([request.kind, request.commentId, refs.base, refs.head]);
  let reason: string;
  try {
    if (await usage.reserve(request, identity, limit)) {
      signal.throwIfAborted();
      return null;
    }
    reason = "The daily assessment allowance has been reached. No assessment ran. Ask again after the UTC day resets or the operator raises the limit.";
  } catch {
    signal.throwIfAborted();
    reason = "The assessment allowance could not be checked. No assessment ran. Ask again after accounting recovers.";
  }
  return request.kind === "review" ? {
    summary: "## Perry review\n\n**HOLD | 0/10 merge readiness (provisional)**\n\n" + reason,
    findings: "## Bugs and suggested fixes\n\n" + reason + " No current bug assessment is available.",
  } : {answer: "## Perry answer\n\n" + reason};
}
