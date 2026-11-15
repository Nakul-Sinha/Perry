import assert from "node:assert/strict";
import { test } from "node:test";
import { processMention, type Bodies, type Refs } from "../src/worker.ts";
import type { CommentSlot } from "../src/github.ts";
import type { MentionRequest } from "../src/intake.ts";
import type { Job } from "../src/store.ts";

const request: MentionRequest = {
  installationId: "17", repoId: "19", owner: "fixture", repo: "demo", number: 2, sender: "dev",
  senderId: "11", commentId: "13", kind: "review", isPR: true, text: "review",
};
const refs = {base: "a".repeat(40), head: "b".repeat(40)};
function harness() {
  const slots = new Map<CommentSlot, string>();
  const comments = new Map<CommentSlot, {id:string; body:string}>();
  const writes: CommentSlot[] = [];
  let stored: unknown = null;
  const job: Job = {
    signal: new AbortController().signal,
    async loadResult<T>() { return stored as T | null; }, async saveResult(result) { stored = result; },
    async getSlot(slot) { return slots.get(slot) ?? null; },
    async markCreating(slot) { assert.ok(!slots.has(slot)); slots.set(slot, "creating"); },
    async saveSlot(slot, id) { slots.set(slot, id); },
  };
  const gateway = {
    async authorize() { return true; }, async refs(): Promise<Refs | null> { return refs; },
    async writeSlot(_r: MentionRequest, slot: CommentSlot, body: string, id?: string, canCreate = true,
      _signal?: AbortSignal, reserve?: () => Promise<void>) {
      const existing = comments.get(slot);
      if (id) assert.equal(id, existing?.id);
      if (!existing) assert.ok(canCreate);
      await reserve?.();
      const result = existing?.id ?? String(comments.size + 1);
      comments.set(slot, {id:result, body}); writes.push(slot);
      return result;
    },
  };
  return {job, slots, comments, writes, gateway};
}

test("an ambiguous findings create resumes from the stored result and reuses both slots", async () => {
  const h = harness();
  const write = h.gateway.writeSlot.bind(h.gateway);
  let lost = true;
  h.gateway.writeSlot = async (...args) => {
    const id = await write(...args);
    if (args[1] === "findings" && lost) { lost = false; throw new Error("Lost receipt"); }
    return id;
  };
  let runs = 0;
  const evaluate = async () => { runs++; return {summary: "DO NOT MERGE | 4/10", findings:"Evidence"}; };
  await assert.rejects(processMention(request, h.job, h.gateway, evaluate), /Lost receipt/);
  assert.match(h.comments.get("summary")!.body, /HOLD \| 0\/10/);
  await processMention(request, h.job, h.gateway, evaluate);
  assert.equal(runs, 1);
  assert.equal(h.comments.size, 2);
  assert.match(h.comments.get("summary")!.body, /DO NOT MERGE \| 4\/10/);
});

test("a changed head between findings and final summary leaves a dated HOLD", async () => {
  const h = harness();
  h.gateway.refs = async () => h.comments.has("findings") ? {...refs, head:"c".repeat(40)} : refs;
  await processMention(request, h.job, h.gateway, async () => ({summary:"previous rating",findings:"previous evidence"}));
  assert.deepEqual(h.writes, ["summary", "findings", "summary"]);
  assert.match(h.comments.get("summary")!.body, /HOLD \| 0\/10/);
  assert.ok(h.comments.get("summary")!.body.includes(refs.head));
});

test("revoked requests do no work; questions only use their answer slot", async () => {
  const h = harness();
  h.gateway.authorize = async () => false;
  const never = async (): Promise<Bodies> => { throw new Error("unexpected invocation"); };
  await processMention(request, h.job, h.gateway, never);
  assert.deepEqual(h.writes, []);
  h.gateway.authorize = async () => true;
  await processMention({...request,kind:"question",text:"where is total?"}, h.job, h.gateway, async () => ({answer:"Cited answer"}));
  assert.deepEqual(h.writes, ["answer"]);
});
