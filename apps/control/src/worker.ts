import type { CommentSlot, GitHubGateway } from "./github.ts";
import type { MentionRequest } from "./intake.ts";
import type { Job } from "./store.ts";

export interface Refs { base: string; head: string; sameRepository?: boolean }
export interface Observation extends Refs { closed: boolean }
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
    const now = await github.refs(r, job.signal);
    const moved = now?.base !== assessment.refs.base || now?.head !== assessment.refs.head;
    const stamp = "\n\nRequested base `" + assessment.refs.base + "`, head `" + assessment.refs.head + "`.";
    await write("answer", assessment.bodies.answer + stamp + (moved ? "\n\nThe source changed or became unavailable before publication. Ask again for the current revision." : ""));
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
    return refs;
  }
  await write("findings", bodies.findings + stamp);
  await write("summary", (await fresh() ? bodies.summary : hold(stale)) + stamp);
  return refs;
}

export type ReviewWatch = {
  request: MentionRequest;
  refs: Refs;
  observed: Observation | null;
  summary: string;
  findings: string;
  signal: AbortSignal;
  begin(observed: Observation): Promise<boolean>;
};

export async function checkReview(watch: ReviewWatch, github: Pick<GitHubGateway, "observeReview" | "invalidateSlot">) {
  const { request, refs, signal } = watch;
  signal.throwIfAborted();
  const observed = watch.observed ?? await github.observeReview(request, signal);
  if (!observed.closed && observed.head === refs.head && observed.base === refs.base) return false;
  // Persist the first observation before touching either slot. On restart we
  // finish that pair even if refs have since moved back to the original SHA.
  if (!watch.observed && !await watch.begin(observed)) return false;
  await github.invalidateSlot(request, "summary", watch.summary, refs, observed, signal);
  signal.throwIfAborted();
  await github.invalidateSlot(request, "findings", watch.findings, refs, observed, signal);
  return true;
}
