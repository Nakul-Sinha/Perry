import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import type { MentionRequest } from "../src/intake.ts";
import { PairingStore, type RunnerScope } from "../src/pairing-store.ts";
import { RemoteStore } from "../src/remote-store.ts";
import type { Bodies } from "../src/worker.ts";

const connectionString = process.env.PERRY_TEST_DATABASE_URL;
const refs = {base: "1".repeat(40), head: "2".repeat(40), sameRepository: false};
const review = {summary: "## Perry review\n\n**HOLD | 4/10 merge readiness (provisional)**\n\nA concise review.",
  findings: "## Bugs and suggested fixes\n\nA concrete fix."};
const answer = {answer: "## Perry answer\n\nSee the checked source."};
function request(scope: RunnerScope): MentionRequest {
  return {...scope, owner: "sample", repo: "project", number: 9, commentId: "1234",
    senderId: "56", sender: "sam", kind: "review", text: "review", isPR: true};
}

test("PostgreSQL scoped remote assessment leases", {skip: !connectionString}, async t => {
  const admin = new Pool({connectionString});
  const schema = "perry_remote_" + randomUUID().replaceAll("-", "");
  const options = {connectionString, options: "-c search_path=" + schema, max: 6};
  const pool = new Pool(options);
  const peer = new Pool(options);
  t.after(async () => {
    try {
      await Promise.all([pool.end(), peer.end()]);
      await admin.query("DROP SCHEMA IF EXISTS " + schema + " CASCADE");
    } finally {await admin.end();}
  });
  await admin.query("CREATE SCHEMA " + schema);
  const pairs = new PairingStore(pool);
  const store = new RemoteStore(pool);
  const other = new RemoteStore(peer);
  await pairs.init();
  await Promise.all([store.init(), other.init()]);
  const enroll = async (scope: RunnerScope) => {
    const code = await pairs.issue(scope);
    const enrolled = await pairs.pair(scope, code.code);
    assert.ok(enrolled);
    return enrolled.runnerId;
  };
  const expire = (id: string) => pool.query("UPDATE perry_remote_jobs SET lease_until = clock_timestamp() - interval '1 second' WHERE id = $1", [id]);
  const waitForBlock = async (blocker: number) => {
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline) {
      const row = await pool.query("SELECT 1 FROM pg_stat_activity WHERE $1::integer = ANY(pg_blocking_pids(pid))", [blocker]);
      if (row.rowCount) return;
      await delay(15);
    }
    throw new Error("The concurrent mutation never waited for the database lock.");
  };

  await t.test("duplicate enqueue preserves the first request and refs across restart", async () => {
    const scope = {installationId: "1", repoId: "2"};
    const r = request(scope);
    const runner = await enroll(scope);
    const ids = await Promise.all(Array.from({length: 8}, (_, i) => (i % 2 ? store : other).enqueue(r, refs)));
    assert.equal(new Set(ids).size, 1);
    const id = ids[0]!;
    assert.equal(await other.enqueue({...r, text: "replacement"}, {...refs, sameRepository: true}), id);
    const claim = await other.claim(scope, runner);
    assert.ok(claim);
    assert.equal(claim.jobId, id);
    assert.deepEqual(claim.request, r);
    assert.deepEqual(claim.refs, refs);
    const variants = await Promise.all([
      store.enqueue(r, {...refs, base: "3".repeat(40)}),
      store.enqueue(r, {...refs, head: "4".repeat(40)}),
      store.enqueue({...r, commentId: "200"}, refs),
      store.enqueue({...r, repoId: "22"}, refs),
      store.enqueue({...r, installationId: "11"}, refs),
    ]);
    assert.equal(new Set([id, ...variants]).size, 6);
    await assert.rejects(store.enqueue(r, {...refs, head: "HEAD"}));
    await assert.rejects(store.enqueue({...r, kind: "clarification"}, refs));
  });

  await t.test("only one active scoped runner claims a job and only the lease digest is stored", async () => {
    const scope = {installationId: "2", repoId: "4"};
    const runners = await Promise.all([enroll(scope), enroll(scope)]);
    const id = await store.enqueue(request(scope), refs);
    const claims = await Promise.all(Array.from({length: 8}, (_, i) => (i % 2 ? store : other).claim(scope, runners[i % 2]!)));
    const winners = claims.filter(c => c !== null);
    assert.equal(winners.length, 1);
    const claim = winners[0]!;
    assert.ok(/^[A-Za-z0-9_-]{43}$/.test(claim.leaseToken), "Lease proof must have 256 bits of random data.");
    const stored = await pool.query(`
      SELECT *, extract(epoch FROM lease_until - clock_timestamp()) AS remaining FROM perry_remote_jobs WHERE id = $1
    `, [id]);
    const row = stored.rows[0]!;
    assert.ok(row.lease_digest === createHash("sha256").update(claim.leaseToken).digest("hex"));
    assert.ok(!JSON.stringify(row).includes(claim.leaseToken), "Raw lease proofs must stay off disk.");
    assert.ok(Number(row.remaining) > 85 && Number(row.remaining) <= 90);
    const wrong = runners.find(runner => runner !== row.runner_id)!;
    assert.equal(await other.complete(scope, wrong, id, claim.leaseToken, review), false);
    assert.equal(await other.heartbeat({...scope, installationId: "55"}, row.runner_id, id, claim.leaseToken), false);
    assert.equal(await other.complete({...scope, repoId: "44"}, row.runner_id, id, claim.leaseToken, review), false);
    assert.equal(await other.complete(scope, row.runner_id, id, "A".repeat(43), review), false);
    assert.equal(await other.heartbeat(scope, row.runner_id, randomUUID(), claim.leaseToken), false);
    await pool.query("UPDATE perry_remote_jobs SET lease_until = clock_timestamp() + interval '10 seconds' WHERE id = $1", [id]);
    assert.equal(await other.heartbeat(scope, row.runner_id, id, claim.leaseToken), true);
    const renewed = await pool.query("SELECT lease_until > clock_timestamp() + interval '85 seconds' AS renewed FROM perry_remote_jobs WHERE id = $1", [id]);
    assert.equal(renewed.rows[0]!.renewed, true);
    assert.equal(await other.result(id), null);
    assert.equal(await other.complete(scope, row.runner_id, id, claim.leaseToken, review), true);
    assert.equal(await store.complete(scope, row.runner_id, id, claim.leaseToken, review), true);
    assert.equal(await store.complete(scope, row.runner_id, id, claim.leaseToken, {...review, summary: review.summary + " Changed."}), false);
    assert.equal(await store.complete(scope, wrong, id, claim.leaseToken, review), false);
    assert.equal(await store.complete(scope, row.runner_id, id, "B".repeat(43), review), false);
    assert.equal(await store.heartbeat(scope, row.runner_id, id, claim.leaseToken), false);
    await store.cancel(id);
    assert.deepEqual(await other.result(id), review);
    assert.equal(await other.claim(scope, wrong), null);
    await pairs.revoke(scope, row.runner_id);
    assert.equal(await store.complete(scope, row.runner_id, id, claim.leaseToken, review), false);
  });

  await t.test("expired attempts cannot renew or complete before or after reassignment", async () => {
    const scope = {installationId: "3", repoId: "6"};
    const runners = await Promise.all([enroll(scope), enroll(scope)]);
    const id = await store.enqueue(request(scope), refs);
    const first = await store.claim(scope, runners[0]!);
    assert.ok(first);
    await expire(id);
    assert.equal(await other.heartbeat(scope, runners[0]!, id, first.leaseToken), false);
    assert.equal(await other.complete(scope, runners[0]!, id, first.leaseToken, review), false);
    const next = await other.claim(scope, runners[0]!);
    assert.ok(next && next.jobId === first.jobId && next.leaseToken !== first.leaseToken);
    assert.equal(await other.complete(scope, runners[0]!, id, first.leaseToken, review), false);
    await expire(id);
    const last = await other.claim(scope, runners[1]!);
    assert.ok(last);
    assert.equal(await store.complete(scope, runners[0]!, id, next.leaseToken, review), false);
    assert.equal(await store.complete(scope, runners[1]!, id, last.leaseToken, review), true);
  });

  await t.test("runner revocation racing completion takes effect at the database mutation", async () => {
    const scope = {installationId: "4", repoId: "8"};
    const runner = await enroll(scope);
    const id = await store.enqueue(request(scope), refs);
    const otherScope = {...scope, repoId: "88"};
    const outsider = await enroll(otherScope);
    assert.equal(await store.claim(scope, outsider), null);
    assert.equal(await store.claim({...scope, installationId: "77"}, runner), null);
    const claim = await store.claim(scope, runner);
    assert.ok(claim);
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      const locked = await holder.query("UPDATE perry_runners SET revoked_at = clock_timestamp() WHERE id = $1 RETURNING pg_backend_pid() AS pid", [runner]);
      const completing = other.complete(scope, runner, id, claim.leaseToken, review);
      await waitForBlock(locked.rows[0]!.pid);
      await holder.query("COMMIT");
      assert.equal(await completing, false);
    } finally {await holder.query("ROLLBACK"); holder.release();}
    assert.equal(await store.heartbeat(scope, runner, id, claim.leaseToken), false);
    await expire(id);
    assert.equal(await store.claim(scope, runner), null);
    const nextRunner = await enroll(scope);
    const next = await other.claim(scope, nextRunner);
    assert.ok(next);
    assert.equal(await other.complete(scope, nextRunner, id, next.leaseToken, review), true);
  });

  await t.test("completion checks expiry after waiting for a job lock", async () => {
    const scope = {installationId: "5", repoId: "10"};
    const runner = await enroll(scope);
    const id = await store.enqueue(request(scope), refs);
    const claim = await store.claim(scope, runner);
    assert.ok(claim);
    await pool.query("UPDATE perry_remote_jobs SET lease_until = clock_timestamp() + interval '1 second' WHERE id = $1", [id]);
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      const locked = await holder.query("SELECT pg_backend_pid() AS pid FROM perry_remote_jobs WHERE id = $1 FOR UPDATE", [id]);
      const completing = other.complete(scope, runner, id, claim.leaseToken, review);
      await waitForBlock(locked.rows[0]!.pid);
      await holder.query("SELECT pg_sleep(greatest(0, extract(epoch FROM lease_until - clock_timestamp())) + 0.02) FROM perry_remote_jobs WHERE id = $1", [id]);
      await holder.query("COMMIT");
      assert.equal(await completing, false);
    } finally {await holder.query("ROLLBACK"); holder.release();}
    assert.equal(await store.result(id), null);
  });

  await t.test("only exact, bounded, publishable body shapes complete the corresponding request", async () => {
    const scope = {installationId: "6", repoId: "12"};
    const runner = await enroll(scope);
    const input = {...request(scope), isPR: false, kind: "question" as const, text: "Which package?"};
    const branch = {base: refs.head, head: refs.head};
    const id = await store.enqueue(input, branch);
    const claim = await store.claim(scope, runner);
    assert.ok(claim);
    assert.deepEqual(claim.refs, branch);
    const heading = "## Perry answer\n\n";
    for (const value of [null, [], review, {answer: 2}, {answer: " "}, {...answer, extra: "data"},
      {answer: "missing heading"}, {answer: heading + "z".repeat(58_001)}, {answer: heading + "\u00e9".repeat(29_001)},
      {answer: heading + "nul\u0000"}, {answer: heading + "\uD800"}]) {
      assert.equal(await other.complete(scope, runner, id, claim.leaseToken, value as Bodies), false);
    }
    const remaining = 58_000 - Buffer.byteLength(heading);
    const full = {answer: heading + "\u00e9".repeat(Math.floor(remaining / 2)) + "a".repeat(remaining % 2)};
    assert.equal(await other.complete(scope, runner, id, claim.leaseToken, full), true);
    assert.ok((await store.result(id) as typeof answer).answer === full.answer);

    const reviewId = await store.enqueue(request(scope), refs);
    const second = await store.claim(scope, runner);
    assert.ok(second);
    assert.equal(await store.complete(scope, runner, reviewId, second.leaseToken, answer), false);
    assert.equal(await store.complete(scope, runner, reviewId, second.leaseToken, {summary: "only one"} as Bodies), false);
    const submit = (summary: string) => store.complete(scope, runner, reviewId, second.leaseToken, {...review, summary});
    for (const summary of [review.summary.replace("HOLD", "MERGE"), review.summary.replace("4/10", "11/10"),
      review.summary.replace("4/10 ", ""), review.summary.replace("## Perry review", "## Another review"),
      review.summary + "\n**MERGE | 10/10 merge readiness**"]) assert.equal(await submit(summary), false);
    assert.equal(await store.complete(scope, runner, reviewId, second.leaseToken, {...review, findings: "No findings heading."}), false);
    assert.equal(await submit(review.summary.replace("HOLD | 4", "DO NOT MERGE | 10").replace(" (provisional)", "")), true);
  });

  await t.test("cancellation fences pending and already leased attempts and survives replay", async () => {
    const scope = {installationId: "7", repoId: "14"};
    const r = request(scope);
    const runner = await enroll(scope);
    const id = await store.enqueue(r, refs);
    await other.cancel(id);
    assert.equal(await store.enqueue(r, refs), id);
    assert.equal(await store.claim(scope, runner), null);
    const next = await store.enqueue({...r, commentId: "4321"}, refs);
    const claim = await other.claim(scope, runner);
    assert.ok(claim && claim.jobId === next);
    await store.cancel(next);
    await other.cancel(next);
    assert.equal(await other.heartbeat(scope, runner, next, claim.leaseToken), false);
    assert.equal(await other.complete(scope, runner, next, claim.leaseToken, review), false);
    await assert.rejects(other.result(next), /assessment was cancelled/);
    assert.equal(await store.claim(scope, runner), null);
  });

  await t.test("the original durable deadline fences jobs and preserves successful receipts", async () => {
    const scope = {installationId: "8", repoId: "16"};
    const runner = await enroll(scope);
    const r = request(scope);
    const id = await store.enqueue(r, refs);
    const deadline = await pool.query(`
      SELECT expires_at BETWEEN queued_at + interval '1199 seconds' AND queued_at + interval '1201 seconds' AS correct
      FROM perry_remote_jobs WHERE id = $1
    `, [id]);
    assert.equal(deadline.rows[0]!.correct, true);
    const pastDeadline = (job: string) => pool.query("UPDATE perry_remote_jobs SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [job]);
    await pastDeadline(id);
    assert.equal(await other.enqueue(r, refs), id);
    assert.equal(await other.claim(scope, runner), null);
    await assert.rejects(other.result(id), /assessment was cancelled/);

    const leased = await store.enqueue({...r, commentId: "800"}, refs);
    const claim = await store.claim(scope, runner);
    assert.ok(claim);
    await pastDeadline(leased);
    assert.equal(await store.heartbeat(scope, runner, leased, claim.leaseToken), false);
    assert.equal(await store.complete(scope, runner, leased, claim.leaseToken, review), false);
    await assert.rejects(other.result(leased), /assessment was cancelled/);
    const retired = await pool.query("SELECT cancelled, lease_digest, runner_id, lease_until FROM perry_remote_jobs WHERE id = $1", [leased]);
    assert.deepEqual(retired.rows[0], {cancelled: true, lease_digest: null, runner_id: null, lease_until: null});

    const completed = await store.enqueue({...r, commentId: "801"}, refs);
    const done = await other.claim(scope, runner);
    assert.ok(done);
    assert.equal(await other.complete(scope, runner, completed, done.leaseToken, review), true);
    await pastDeadline(completed);
    assert.deepEqual(await other.result(completed), review);
    assert.equal(await store.complete(scope, runner, completed, done.leaseToken, review), true);
    assert.equal(await store.heartbeat(scope, runner, completed, done.leaseToken), false);
  });
});
