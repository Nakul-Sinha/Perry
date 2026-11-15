import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import type { MentionRequest } from "../src/intake.ts";
import { Store, type Job } from "../src/store.ts";

const connectionString = process.env.PERRY_TEST_DATABASE_URL;
const request = (commentId: string, overrides: Partial<MentionRequest> = {}): MentionRequest => ({
  installationId: "101", repoId: "202", owner: "example", repo: "comparison", number: 1, commentId,
  sender: "maintainer", senderId: "303", kind: "review", text: "review", isPR: true, ...overrides,
});

test("PostgreSQL mention queue", { skip: !connectionString }, async t => {
  const admin = new Pool({ connectionString });
  const schema = "perry_test_" + randomUUID().replaceAll("-", "");
  const scoped = { connectionString, options: "-c search_path=" + schema, max: 5 };
  const pool = new Pool(scoped);
  const peer = new Pool(scoped);
  t.after(async () => {
    try {
      await Promise.all([pool.end(), peer.end()]);
      await admin.query("DROP SCHEMA IF EXISTS " + schema + " CASCADE");
    } finally {
      await admin.end();
    }
  });
  await admin.query("CREATE SCHEMA " + schema);
  const store = new Store(pool);
  const other = new Store(peer);
  await Promise.all([store.init(), other.init()]);
  const fastForward = () => pool.query("UPDATE perry_mentions SET available_at = now() WHERE state = 'pending'");

  // Handler exceptions normally trigger production retries. Surface test
  // assertion errors to the harness after the worker releases its lock.
  async function success(worker: Store, callback: (r: MentionRequest, job: Job) => Promise<void>) {
    let failure: unknown;
    const ran = await worker.workOne(async (r, job) => {
      try { await callback(r, job); } catch (error) { failure = error; throw error; }
    });
    if (failure) throw failure;
    assert.equal(ran, true);
  }

  await t.test("concurrent redelivery creates one job per semantic request", async () => {
    await Promise.all([
      store.accept("a", request("1")), other.accept("a", request("1")),
      other.accept("b", request("1")),
    ]);
    await store.accept("b", request("2"));
    await success(store, async r => { assert.equal(r.commentId, "1"); });
    assert.equal(await other.workOne(async () => {}), false);
    assert.equal((await pool.query("SELECT id FROM perry_deliveries")).rowCount, 2);
  });

  await t.test("the next worker skips a locked thread and processes another repository", async () => {
    await store.accept("c", request("3"));
    await store.accept("d", request("4"));
    await store.accept("e", request("3", { repoId: "404" }));
    const entered = Promise.withResolvers<void>();
    const unlock = Promise.withResolvers<void>();
    const working = success(store, async (r, job) => {
      entered.resolve();
      assert.equal(r.commentId, "3");
      await job.markCreating("summary");
      await job.saveSlot("summary", "500");
      await unlock.promise;
    });
    try {
      await entered.promise;
      await success(other, async (r, job) => {
        assert.equal(r.repoId, "404");
        assert.equal(await job.getSlot("summary"), null);
      });
      assert.equal(await other.workOne(async () => {}), false);
    } finally {
      unlock.resolve();
      await working;
    }
    await success(other, async (r, job) => {
      assert.equal(r.commentId, "4");
      assert.equal(await job.getSlot("summary"), "500");
    });
  });

  await t.test("restart reconciles an ambiguous create and reuses the immutable result", async () => {
    await store.accept("f", request("5"));
    await store.workOne(async (_r, job) => {
      await job.saveResult({ snapshot: "head", findings: [] });
      await job.markCreating("findings");
      throw new Error("Response was lost after the HTTP request.");
    });
    await fastForward();
    const resumed = new Store(peer);
    await success(resumed, async (_r, job) => {
      assert.deepEqual(await job.loadResult(), {snapshot: "head", findings: []});
      await assert.rejects(job.saveResult({ snapshot: "new head" }), /immutable/);
      assert.equal(await job.getSlot("findings"), "creating");
      await assert.rejects(job.markCreating("findings"), /already exists/);
      await job.saveSlot("findings", "501");
      await job.saveSlot("findings", "501");
      await assert.rejects(job.saveSlot("findings", "502"), /replace/);
      assert.equal(await job.getSlot("summary"), "500");
    });
  });

  await t.test("answers have request-specific slots separate from the review", async () => {
    for (const id of ["6", "7"]) {
      await store.accept("answer-" + id, request(id, { kind: "question" }));
      await success(store, async (_r, job) => {
        assert.equal(await job.getSlot("answer"), null);
        await assert.rejects(job.getSlot("summary"), /cannot publish/);
        await job.markCreating("answer");
        await job.saveSlot("answer", "80" + id);
      });
    }
  });

  await t.test("losing a publisher session aborts its work and releases the thread for reconciliation", async () => {
    const applicationName = schema + "_crash";
    const dedicated = new Pool({ ...scoped, application_name: applicationName, max: 1 });
    try {
      await store.accept("disconnect", request("10"));
      const entered = Promise.withResolvers<void>();
      let stale: Job | undefined;
      const crashed = new Store(dedicated).workOne(async (_r, job) => {
        stale = job;
        await job.saveResult({ commit: "initial" });
        const aborted = Promise.withResolvers<void>();
        job.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
        entered.resolve();
        await aborted.promise;
        job.signal.throwIfAborted();
      });
      const stopped = assert.rejects(crashed, /session closed/);
      await entered.promise;
      const killed = await admin.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1", [applicationName],
      );
      assert.equal(killed.rowCount, 1);
      await stopped;
      await assert.rejects(stale!.saveResult({ commit: "stale" }), /session closed/);
      await success(other, async (_r, job) => {
        assert.deepEqual(await job.loadResult(), { commit: "initial" });
      });
    } finally {
      await dedicated.end();
    }
  });

  await t.test("exhausted retries quarantine only their thread and allow scoped repair", async () => {
    await store.accept("retry-a", request("8"));
    await store.accept("retry-b", request("9"));
    let attempts = 0;
    const failed = async () => {
      attempts++;
      throw new Error("GitHub is unavailable.");
    };
    for (let i = 0; i < 5; i++) {
      assert.equal(await store.workOne(failed), true);
      assert.equal(await other.workOne(failed), false);
      await fastForward();
    }
    assert.equal(attempts, 5);
    assert.equal(await other.workOne(failed), false);
    assert.equal(await store.retryFailed("999", "202", 1, "8"), false);
    assert.equal(await store.retryFailed("101", "202", 1, "8"), true);
    assert.equal(await other.retryFailed("101", "202", 1, "8"), false);
    const ids: string[] = [];
    while (await other.workOne(async r => { ids.push(r.commentId); })) {}
    assert.deepEqual(ids, ["8", "9"]);
  });

  await t.test("periodic watches retain ownership across retries and yield to later authorized reviews", async () => {
    const scope = {installationId:"101", repoId:"202"};
    const key = JSON.stringify(["101","202",61]);
    const post = (id:string, kind: MentionRequest["kind"] = "review") => store.accept("watch-"+id, request(id,{number:61,kind}));
    const due = () => pool.query("UPDATE perry_review_watches SET due_at = now() WHERE scope = $1", [key]);
    const never = async () => { throw new Error("Unexpected watch callback"); };
    const refs = {base:"a".repeat(40),head:"b".repeat(40)};
    const changed = {...refs, head:"c".repeat(40), closed:false};
    await post("81");
    assert.equal(await store.workOne(async (_r,job) => {
      for (const [slot, id] of [["summary","81"],["findings","82"]] as const) {
        await job.markCreating(slot); await job.saveSlot(slot,id);
      }
      await job.saveResult({refs,bodies:{summary:"ok",findings:"ok"}});
      return refs;
    },scope), true);
    assert.equal(await store.pollOne(scope, never), false);
    await due();
    assert.equal(await store.pollOne({...scope,repoId:"444"}, never), false);
    // A question can run during maintenance without becoming the pair's owner.
    await post("82","question");
    await success(store, async () => {});
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    let fenced: boolean | undefined;
    const first = store.pollOne(scope, async watch => {
      entered.resolve();
      await resume.promise;
      fenced = await watch.begin(changed);
      return false;
    });
    await entered.promise;
    try {
      assert.equal(await other.pollOne(scope, never), false);
      await post("83");
      assert.equal(await other.workOne(async () => {},scope), false);
    } finally { resume.resolve(); }
    assert.equal(await first,true);
    assert.equal(fenced,false);
    await due();
    assert.equal(await other.pollOne(scope, never), false);
    // An unauthorized or deleted trigger finishes without publishing a result.
    await success(store, async () => {});
    assert.equal(await other.pollOne(scope, async watch => {
      assert.equal(watch.request.commentId,"81");
      assert.equal(await watch.begin(changed),true);
      throw new Error("Simulated ambiguous update");
    }), true);
    const state = await pool.query("SELECT failures, observed, due_at > now() AS waiting FROM perry_review_watches WHERE scope = $1", [key]);
    assert.deepEqual(state.rows[0], {failures:1, observed:changed, waiting:true});
    await post("84");
    assert.equal(await store.workOne(async () => {},scope),false);
    await due();
    let repaired = false;
    await other.pollOne(scope, async watch => {
      assert.equal(watch.summary,"81");
      assert.equal(watch.findings,"82");
      assert.deepEqual(watch.observed,changed);
      repaired = true;
      return true;
    });
    assert.equal(repaired,true);
    assert.equal(await store.pollOne(scope,never),false);
    await store.workOne(async () => changed,scope);
    await due();
    let replacement = "";
    await store.pollOne(scope,async watch => { replacement = watch.request.commentId; return false; });
    assert.equal(replacement,"84");
  });
});
