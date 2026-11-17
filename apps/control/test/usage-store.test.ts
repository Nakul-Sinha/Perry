import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { UsageStore } from "../src/usage-store.ts";

const connectionString = process.env.PERRY_TEST_DATABASE_URL;
test("PostgreSQL assessment usage budgets", {skip: !connectionString}, async t => {
  const admin = new Pool({connectionString});
  const schema = "perry_usage_" + randomUUID().replaceAll("-", "");
  // Put sessions on a different calendar date from UTC for this run.
  const clock = await admin.query(`
    SELECT CASE WHEN extract(hour FROM now() AT TIME ZONE 'UTC') < 12
      THEN 'Etc/GMT+12' ELSE 'Pacific/Kiritimati' END AS zone
  `);
  const options = {connectionString, options: "-c search_path=" + schema + " -c timezone=" + clock.rows[0]!.zone, max: 6};
  const pool = new Pool(options);
  const peer = new Pool(options);
  t.after(async () => {
    try {
      await Promise.all([pool.end(), peer.end()]);
      await admin.query("DROP SCHEMA IF EXISTS " + schema + " CASCADE");
    } finally {await admin.end();}
  });
  await admin.query("CREATE SCHEMA " + schema);
  const store = new UsageStore(pool);
  const other = new UsageStore(peer);
  await Promise.all([store.init(), other.init()]);

  await t.test("distinct concurrent requests cannot oversubscribe the scope", async () => {
    const scope = {installationId: "10", repoId: "20"};
    const limit = 5;
    const reserve = (i: number) => (i % 2 ? store : other).reserve(scope, "review:" + i, limit);
    const keys = Array.from({length: 32}, (_, i) => i);
    const accepted = await Promise.all(keys.map(reserve));
    assert.equal(accepted.filter(Boolean).length, limit);
    assert.deepEqual(await Promise.all(keys.map(reserve)), accepted);
    assert.equal((await store.totals(scope)).used, limit);
    const counts = await pool.query("SELECT count(*)::int AS count FROM perry_usage_reservations WHERE installation_id = $1 AND repo_id = $2", ["10", "20"]);
    assert.equal(counts.rows[0]!.count, limit);
  });

  await t.test("simultaneous deliveries of one semantic request share one charge", async () => {
    const scope = {installationId: "30", repoId: "40"};
    const key = "question:17:0123:abcd";
    const reservations = await Promise.all(Array.from({length: 24}, (_, i) => (i % 2 ? store : other).reserve(scope, key, 1)));
    assert.ok(reservations.every(Boolean));
    assert.equal((await other.totals(scope)).used, 1);
    const rows = await pool.query("SELECT * FROM perry_usage_reservations WHERE installation_id = $1", ["30"]);
    assert.equal(rows.rowCount, 1);
    assert.equal(rows.rows[0]!.key_digest, createHash("sha256").update(key).digest("hex"));
    assert.ok(!JSON.stringify(rows.rows).includes(key));
    assert.equal(await other.reserve(scope, "second", 1), false);
    assert.equal(await other.reserve(scope, "second", 2), true);
    assert.equal(await store.reserve(scope, "third", 1), false);
    assert.equal(await store.reserve(scope, "second", 1), true);
    assert.equal((await store.totals(scope)).used, 2);
  });

  await t.test("current totals use UTC and replaying a prior day does not charge today", async () => {
    const scope = {installationId: "50", repoId: "60"};
    const dates = await pool.query(`
      SELECT to_char(current_date, 'YYYY-MM-DD') AS local_day,
        to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS utc_day
    `);
    const date = dates.rows[0]!.utc_day;
    assert.notEqual(date, dates.rows[0]!.local_day);
    assert.deepEqual(await other.totals(scope), {used: 0, date});
    assert.equal(await store.reserve(scope, "yesterday", 1), true);
    assert.equal(await other.reserve(scope, "today", 1), false);
    const prior = await pool.query("SELECT to_char(usage_day, 'YYYY-MM-DD') AS day FROM perry_usage_reservations WHERE installation_id = '50'");
    assert.equal(prior.rows[0]!.day, date);
    await pool.query(`
      UPDATE perry_usage_reservations SET usage_day = usage_day - 1 WHERE installation_id = '50';
      UPDATE perry_usage_days SET usage_day = usage_day - 1 WHERE installation_id = '50';
    `);
    assert.deepEqual(await other.totals(scope), {used: 0, date});
    assert.equal(await other.reserve(scope, "yesterday", 1), true);
    assert.deepEqual(await store.totals(scope), {used: 0, date});
    assert.equal(await store.reserve(scope, "today", 1), true);
    assert.deepEqual(await other.totals(scope), {used: 1, date});
  });

  await t.test("installations and repositories have independent daily limits and deduplication", async () => {
    const scope = {installationId: "70", repoId: "80"};
    const neighbors = [{...scope, installationId: "71"}, {...scope, repoId: "81"}];
    assert.equal(await store.reserve(scope, "same", 1), true);
    assert.equal(await store.reserve(scope, "other", 1), false);
    for (const neighbor of neighbors) {
      assert.equal((await other.totals(neighbor)).used, 0);
      assert.equal(await other.reserve(neighbor, "same", 1), true);
      assert.equal((await other.totals(neighbor)).used, 1);
    }
    assert.equal((await store.totals(scope)).used, 1);
  });

  await t.test("failed accounting leaves a previously unseen key eligible for retry", async () => {
    const scope = {installationId: "90", repoId: "91"};
    await pool.query("ALTER TABLE perry_usage_days ADD CONSTRAINT reject_scope CHECK (repo_id <> '91') NOT VALID");
    try { await assert.rejects(other.reserve(scope, "retry", 1), {code: "23514"}); }
    finally { await pool.query("ALTER TABLE perry_usage_days DROP CONSTRAINT reject_scope"); }
    assert.equal((await store.totals(scope)).used, 0);
    assert.equal(await store.reserve(scope, "retry", 1), true);
    assert.equal((await other.totals(scope)).used, 1);
  });

  await t.test("invalid limits, scopes and request identities leave the budget untouched", async () => {
    const scope = {installationId: "100", repoId: "110"};
    for (const limit of [0, -1, 1.5, 1_000_001, NaN, Infinity]) {
      await assert.rejects(store.reserve(scope, "request", limit), /limit/);
    }
    for (const key of ["", "   ", "\u00e9".repeat(513)]) await assert.rejects(store.reserve(scope, key, 1), /identity/);
    await assert.rejects(store.reserve({...scope, installationId: "0"}, "request", 1), /scope/);
    await assert.rejects(store.totals({...scope, repoId: "-1"}), /scope/);
    assert.equal((await store.totals(scope)).used, 0);
    assert.equal(await store.reserve(scope, "\u00e9".repeat(512), 1_000_000), true);
  });
});
