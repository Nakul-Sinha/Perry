import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Pool } from "pg";
import { assessmentAdmission, dailyAssessmentLimit } from "../src/assessment-budget.ts";
import type { CommentSlot } from "../src/github.ts";
import type { MentionRequest } from "../src/intake.ts";
import { Store } from "../src/store.ts";
import { UsageStore } from "../src/usage-store.ts";
import { processMention, type Bodies } from "../src/worker.ts";

const connectionString = process.env.PERRY_TEST_DATABASE_URL;
const refs = {base: "a".repeat(40), head: "b".repeat(40)};
const request = (commentId: string, overrides: Partial<MentionRequest> = {}): MentionRequest => ({
  installationId: "101", repoId: "202", owner: "example", repo: "comparison", number: 1,
  commentId, sender: "maintainer", senderId: "303", kind: "review", text: "review", isPR: true, ...overrides,
});

test("daily assessment configuration is optional and rejects ambiguous or unbounded values", () => {
  assert.equal(dailyAssessmentLimit(undefined), undefined);
  assert.equal(dailyAssessmentLimit("1"), 1);
  assert.equal(dailyAssessmentLimit("1000000"), 1_000_000);
  for (const value of ["", "0", "-1", "1.5", "1000001", "Infinity", "NaN", "1e3", " 5", "05"]) {
    assert.throws(() => dailyAssessmentLimit(value), /Configure PERRY_DAILY_ASSESSMENT_LIMIT/);
  }
});

test("unlimited admission does not access accounting and cancellation never admits work", async () => {
  const usage = {async reserve() { assert.fail("Unlimited assessments must not use accounting."); }};
  assert.equal(await assessmentAdmission(usage, request("1"), refs, undefined, new AbortController().signal), null);
  const cancelled = AbortSignal.abort(new Error("Cancelled"));
  await assert.rejects(assessmentAdmission(usage, request("1"), refs, 1, cancelled), /Cancelled/);
});

test("assessment limits precede source work and survive queue publication recovery", {skip: !connectionString}, async t => {
  const schema = "perry_admission_" + randomUUID().replaceAll("-", "");
  const admin = new Pool({connectionString});
  const pool = new Pool({connectionString, options: "-c search_path=" + schema, max: 6});
  t.after(async () => {
    await pool.end();
    try { await admin.query("DROP SCHEMA IF EXISTS " + schema + " CASCADE"); }
    finally { await admin.end(); }
  });
  await admin.query("CREATE SCHEMA " + schema);
  const store = new Store(pool);
  const usage = new UsageStore(pool);
  await Promise.all([store.init(), usage.init()]);
  const comments = new Map<string, {id: string; body: string}>();
  let permission = true;
  let lostFindingsReceipt = false;
  let admissions = 0;
  let assessments = 0;
  const slotKey = (r: MentionRequest, slot: CommentSlot) => JSON.stringify([r.repoId, r.number, slot, slot === "answer" ? r.commentId : ""]);
  const github = {
    async authorize() { return permission; },
    async refs() { return refs; },
    async writeSlot(r: MentionRequest, slot: CommentSlot, body: string, receipt?: string, create = true,
      _signal?: AbortSignal, beforeWrite?: () => Promise<void>) {
      const key = slotKey(r, slot);
      const existing = comments.get(key);
      if (receipt) assert.equal(receipt, existing?.id);
      if (!existing) assert.ok(create);
      await beforeWrite?.();
      const id = existing?.id ?? String(comments.size + 100);
      comments.set(key, {id, body});
      if (slot === "findings" && lostFindingsReceipt) {
        lostFindingsReceipt = false;
        throw new Error("Lost publication receipt");
      }
      return id;
    },
  };
  const work = (scope: {installationId: string; repoId: string}, limit: number | undefined = 1) => store.workOne(
    (r, job) => processMention(r, job, github, async (r, pinned, signal): Promise<Bodies> => {
      admissions++;
      const denied = await assessmentAdmission(usage, r, pinned, limit, signal);
      if (denied) return denied;
      // This callback stands for either local source/model work or remote enqueue.
      assessments++;
      return r.kind === "review" ? {summary: "## Perry review\n\n**HOLD | 6/10 merge readiness**", findings: "## Bugs and suggested fixes\n\nNo verified bugs."}
        : {answer: "## Perry answer\n\nCited source."};
    }), scope,
  );
  const body = (r: MentionRequest, slot: CommentSlot) => comments.get(slotKey(r, slot))!.body;

  await t.test("authorized admission counts once while a lost write replays the immutable result", async () => {
    const r = request("1");
    await store.accept("first", r);
    await store.accept("first", r);
    await store.accept("redelivery", r);
    lostFindingsReceipt = true;
    assert.equal(await work(r), true);
    assert.equal((await pool.query("SELECT state FROM perry_mentions WHERE comment_id = '1'")).rows[0].state, "pending");
    await pool.query("UPDATE perry_mentions SET available_at = now() WHERE comment_id = '1'");
    assert.equal(await work(r), true);
    assert.equal((await pool.query("SELECT state FROM perry_mentions WHERE comment_id = '1'")).rows[0].state, "done");
    assert.equal(await work(r), false);
    assert.equal(admissions, 1);
    assert.equal(assessments, 1);
    assert.equal((await usage.totals(r)).used, 1);
    assert.equal(comments.size, 2);
    assert.match(body(r, "summary"), /HOLD \| 6\/10/);
  });

  await t.test("exhaustion publishes a provisional review and a separate question without assessment", async () => {
    const review = request("2", {number: 2});
    await store.accept("second", review);
    assert.equal(await work(review), true);
    assert.match(body(review, "summary"), /HOLD \| 0\/10.*provisional/);
    assert.match(body(review, "summary"), /daily assessment allowance.*reached/);
    assert.match(body(review, "findings"), /No current bug assessment/);
    const before = [body(review, "summary"), body(review, "findings")];
    const question = {...review, kind: "question" as const, text: "Where is total?", commentId: "3"};
    await store.accept("question", question);
    assert.equal(await work(question), true);
    assert.match(body(question, "answer"), /daily assessment allowance.*reached/);
    assert.doesNotMatch(body(question, "answer"), /\/10/);
    assert.deepEqual([body(review, "summary"), body(review, "findings")], before);
    assert.equal(assessments, 1);
    assert.equal((await usage.totals(review)).used, 1);
  });

  await t.test("revoked requests never reserve or evaluate", async () => {
    const r = request("4", {repoId: "204", number: 4});
    const before = admissions;
    permission = false;
    try {
      await store.accept("revoked", r);
      assert.equal(await work(r), true);
    } finally { permission = true; }
    assert.equal(admissions, before);
    assert.equal((await usage.totals(r)).used, 0);
    assert.equal(comments.has(slotKey(r, "summary")), false);
  });

  await t.test("an accounting failure leaves a clear provisional result and no source work", async () => {
    const r = request("5", {repoId: "205", number: 5});
    await pool.query("ALTER TABLE perry_usage_days ADD CONSTRAINT admission_failure CHECK (repo_id <> '205') NOT VALID");
    try {
      await store.accept("accounting-outage", r);
      assert.equal(await work(r), true);
    } finally { await pool.query("ALTER TABLE perry_usage_days DROP CONSTRAINT admission_failure"); }
    assert.match(body(r, "summary"), /HOLD \| 0\/10/);
    assert.match(body(r, "summary"), /allowance could not be checked/);
    assert.equal((await usage.totals(r)).used, 0);
    assert.equal(assessments, 1);
  });

  await t.test("the usage command needs only database, scope and optional limit", async () => {
    const url = new URL(connectionString!);
    url.searchParams.set("options", "-c search_path=" + schema);
    const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
    const env = {PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, DATABASE_URL: url.href,
      PERRY_INSTALLATION_ID: "101", PERRY_REPOSITORY_ID: "202", PERRY_DAILY_ASSESSMENT_LIMIT: "1",
      PERRY_EXECUTION_MODE: "not-a-mode"};
    const run = promisify(execFile);
    const result = await run(process.execPath, [entry, "--usage"], {env, windowsHide: true});
    assert.match(result.stdout, /UTC day: \d{4}-\d{2}-\d{2}/);
    assert.match(result.stdout, /Admitted assessments: 1\nDaily limit: 1/);
    const unlimited = await run(process.execPath, [entry, "--usage"], {env: {...env, PERRY_DAILY_ASSESSMENT_LIMIT: undefined}, windowsHide: true});
    assert.match(unlimited.stdout, /Daily limit: unlimited/);
    await assert.rejects(run(process.execPath, [entry, "--usage"], {env: {...env, DATABASE_URL: undefined, PERRY_DAILY_ASSESSMENT_LIMIT: "0"}, windowsHide: true}),
      (error: unknown) => error instanceof Error && "stderr" in error && String(error.stderr).includes("Configure PERRY_DAILY_ASSESSMENT_LIMIT"));
    await assert.rejects(run(process.execPath, [entry, "--usage", "extra"], {env, windowsHide: true}),
      (error: unknown) => error instanceof Error && "stderr" in error && String(error.stderr).includes("run --usage without arguments"));
  });
});
