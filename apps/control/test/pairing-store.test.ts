import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { PairingStore } from "../src/pairing-store.ts";

const connectionString = process.env.PERRY_TEST_DATABASE_URL;
const scope = {installationId: "101", repoId: "202"};
const otherRepo = {...scope, repoId: "404"};
const otherInstallation = {...scope, installationId: "505"};
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const isOpaque = (value: string) => /^[A-Za-z0-9_-]{43}$/.test(value);

test("PostgreSQL scoped runner enrollment", {skip: !connectionString}, async t => {
  const admin = new Pool({connectionString});
  const schema = "perry_pairing_" + randomUUID().replaceAll("-", "");
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
  const store = new PairingStore(pool);
  const other = new PairingStore(peer);
  await Promise.all([store.init(), other.init()]);

  await t.test("operator codes are opaque, digest-only and expire ten minutes after issuance", async () => {
    const issued = await store.issue(scope);
    assert.ok(isOpaque(issued.code), "An enrollment code must contain 256 random bits in base64url form.");
    assert.ok(issued.expiresAt instanceof Date);
    const rows = await pool.query(`
      SELECT *, expires_at BETWEEN clock_timestamp() + interval '9 minutes'
        AND clock_timestamp() + interval '10 minutes' AS expected_lifetime
      FROM perry_pairing_codes WHERE code_digest = $1
    `, [hash(issued.code)]);
    assert.equal(rows.rowCount, 1);
    assert.equal(rows.rows[0].expected_lifetime, true);
    assert.ok(rows.rows[0].expires_at.getTime() === issued.expiresAt.getTime());
    assert.ok(!JSON.stringify(rows.rows).includes(issued.code), "Raw enrollment codes must never enter storage.");
  });

  await t.test("wrong scopes cannot consume a code or identify its runner", async () => {
    const issued = await store.issue(scope);
    assert.equal(await other.pair(otherRepo, issued.code), null);
    assert.equal(await other.pair(otherInstallation, issued.code), null);
    const enrolled = await store.pair(scope, issued.code);
    assert.ok(enrolled, "The correct scope must still be able to consume the code.");
    assert.ok(isOpaque(enrolled.token), "A runner token must contain 256 random bits in base64url form.");
    assert.ok(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(enrolled.runnerId));
    assert.ok(await other.identify(scope, enrolled.token) === enrolled.runnerId);
    assert.equal(await store.identify(otherRepo, enrolled.token), null);
    assert.equal(await store.identify(otherInstallation, enrolled.token), null);
    const rows = await pool.query("SELECT * FROM perry_runners WHERE id = $1", [enrolled.runnerId]);
    assert.equal(rows.rowCount, 1);
    assert.ok(rows.rows[0].token_digest === hash(enrolled.token));
    assert.ok(!JSON.stringify(rows.rows).includes(enrolled.token), "Raw runner tokens must never enter storage.");
  });

  await t.test("concurrent exchanges and later replay create exactly one runner", async () => {
    const issued = await store.issue(scope);
    const outcomes = await Promise.all(Array.from({length: 8}, (_, i) =>
      (i % 2 ? store : other).pair(scope, issued.code)));
    const successful = outcomes.filter(value => value !== null);
    assert.equal(successful.length, 1);
    assert.equal(await store.pair(scope, issued.code), null);
    assert.ok(await other.identify(scope, successful[0]!.token) === successful[0]!.runnerId);
  });

  await t.test("simultaneous onboarding codes remain independent", async () => {
    const issued = await Promise.all([store.issue(scope), other.issue(scope)]);
    assert.ok(issued[0]!.code !== issued[1]!.code, "Independent enrollment requests need distinct codes.");
    const enrolled = await Promise.all(issued.map((item, i) => (i ? store : other).pair(scope, item.code)));
    assert.ok(enrolled.every(value => value !== null));
    assert.ok(enrolled[0]!.runnerId !== enrolled[1]!.runnerId);
    assert.ok(enrolled[0]!.token !== enrolled[1]!.token, "Independent runners need distinct tokens.");
  });

  await t.test("expired and unissued codes cannot enroll", async () => {
    const issued = await store.issue(scope);
    await pool.query("UPDATE perry_pairing_codes SET expires_at = clock_timestamp() - interval '1 second' WHERE code_digest = $1", [hash(issued.code)]);
    assert.equal(await store.pair(scope, issued.code), null);
    assert.equal(await store.pair(scope, randomBytes(32).toString("base64url")), null);
    assert.equal(await store.pair(scope, "invalid-code"), null);
    assert.equal(await store.identify(scope, "invalid-token"), null);
    assert.equal(await store.identify(scope, randomBytes(32).toString("base64url")), null);
  });

  await t.test("failed runner insertion does not consume the enrollment code", async () => {
    const issued = await store.issue(scope);
    await pool.query("ALTER TABLE perry_runners ADD CONSTRAINT reject_fixture_enrollment CHECK (false) NOT VALID");
    try {
      await assert.rejects(store.pair(scope, issued.code), error =>
        error !== null && typeof error === "object" && "code" in error && error.code === "23514");
    } finally {await pool.query("ALTER TABLE perry_runners DROP CONSTRAINT reject_fixture_enrollment");}
    assert.ok(await other.pair(scope, issued.code), "A rolled-back exchange must leave the code usable.");
  });

  await t.test("revocation is scoped and permanently rejects the runner token", async () => {
    const issued = await store.issue(scope);
    const enrolled = await store.pair(scope, issued.code);
    assert.ok(enrolled);
    assert.equal(await other.revoke(otherRepo, enrolled.runnerId), false);
    assert.equal(await other.revoke(otherInstallation, enrolled.runnerId), false);
    assert.ok(await store.identify(scope, enrolled.token) === enrolled.runnerId);
    assert.equal(await other.revoke(scope, enrolled.runnerId), true);
    assert.equal(await store.identify(scope, enrolled.token), null);
    assert.equal(await store.revoke(scope, enrolled.runnerId), false);
    assert.equal(await store.revoke(scope, "invalid-runner"), false);
    assert.equal(await store.pair(scope, issued.code), null);
  });

  await t.test("invalid scope identifiers are rejected without including their input", async () => {
    const invalid = {installationId: "invalid fixture scope", repoId: "202"};
    await assert.rejects(store.issue(invalid), /^Error: Invalid runner enrollment scope\.$/);
    await assert.rejects(store.pair(invalid, "invalid-code"), /^Error: Invalid runner enrollment scope\.$/);
    await assert.rejects(store.identify(invalid, "invalid-token"), /^Error: Invalid runner enrollment scope\.$/);
    await assert.rejects(store.revoke(invalid, randomUUID()), /^Error: Invalid runner enrollment scope\.$/);
  });
});
