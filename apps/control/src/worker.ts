import type { CommentSlot, GitHubGateway } from "./github.ts";
import type { MentionRequest } from "./intake.ts";
import type { Job } from "./store.ts";

export interface Refs { base: string; head: string }
export type Bodies = { summary: string; findings: string } | { answer: string };
type Assessment = { refs: Refs; bodies: Bodies };
type Gateway = Pick<GitHubGateway, "authorize" | "refs" | "writeSlot">;
type Evaluate = (request: MentionRequest, refs: Refs, signal: AbortSignal) => Promise<Bodies>;
const hold = (reason: string) => "## Perry review\n\n**HOLD | 0/10 merge readiness (provisional)**\n\n" + reason;
const stale = "The pull request changed during this review. Request a new review for the current commits.";

export async function processMention(r: MentionRequest, job: Job, github: Gateway, evaluate: Evaluate) {
  async function write(slot: CommentSlot, body: string) {
    job.signal.throwIfAborted();
    const saved = await job.getSlot(slot);
    job.signal.throwIfAborted();
    const reserve = saved === null ? () => job.markCreating(slot) : undefined;
    const id = await github.writeSlot(r, slot, body, saved && saved !== "creating" ? saved : undefined, saved === null, job.signal, reserve);
    await job.saveSlot(slot, id);
  }
  job.signal.throwIfAborted();
  if (!await github.authorize(r, job.signal)) return;
  if (r.kind === "clarification") {
    await write("answer", "Mention Perry in the pull request you want reviewed. You can ask repository questions in this issue.");
    return;
  }
  const current = await github.refs(r, job.signal);
  if (!current) return;
  if (r.kind === "review") await write("summary", hold("Perry is checking the requested commits."));
  let assessment = await job.loadResult<Assessment>();
  if (!assessment) {
    let bodies: Bodies;
    try {
      bodies = await evaluate(r, current, job.signal);
    } catch {
      job.signal.throwIfAborted();
      bodies = r.kind === "review" ? {
        summary: hold("Source acquisition or assessment failed. Request another review to retry."),
        findings: "## Bugs and suggested fixes\n\nThe assessment could not finish. No current bug assessment is available.",
      } : { answer: "## Perry answer\n\nThe requested source could not be assessed. Ask again to retry." };
    }
    if (Object.values(bodies).some(text => Buffer.byteLength(text) > 58_000)) {
      bodies = r.kind === "review" ? {
        summary: hold("The complete review exceeds the comment budget. Publication is incomplete."),
        findings: "## Bugs and suggested fixes\n\nThe full finding list exceeds the comment budget. Run the local review on these commits to inspect it.",
      } : { answer: "## Perry answer\n\nThe answer exceeds the comment budget. Please narrow the question." };
    }
    assessment = {refs: current, bodies};
    await job.saveResult(assessment);
  }
  if ("answer" in assessment.bodies) {
    await write("answer", assessment.bodies.answer);
    return;
  }
  const {refs, bodies} = assessment;
  const stamp = "\n\nRequested base `" + refs.base + "`, head `" + refs.head + "`.";
  const fresh = async () => {
    job.signal.throwIfAborted();
    const now = await github.refs(r, job.signal);
    return now?.head === refs.head && now.base === refs.base;
  };
  if (!await fresh()) {
    await write("findings", "## Bugs and suggested fixes\n\n" + stale + stamp);
    await write("summary", hold(stale) + stamp);
    return;
  }
  await write("findings", bodies.findings + stamp);
  await write("summary", (await fresh() ? bodies.summary : hold(stale)) + stamp);
}
