import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Pool } from "pg";

const connectionString = process.env.PERRY_TEST_DATABASE_URL;

test("the control process serves health, authenticates requests and requeues a failed mention", {
  skip: !connectionString, timeout: 30_000,
}, async t => {
  const schema = "perry_service_" + randomUUID().replaceAll("-", "");
  const admin = new Pool({connectionString});
  const root = await mkdtemp(join(tmpdir(), "perry-service-"));
  t.after(async () => {
    try { await admin.query("DROP SCHEMA IF EXISTS " + schema + " CASCADE"); }
    finally { await admin.end(); await rm(root, {recursive: true, force: true, maxRetries: 3}); }
  });
  await admin.query("CREATE SCHEMA " + schema);
  const url = new URL(connectionString!);
  url.searchParams.set("options", "-c search_path=" + schema);
  const pem = join(root, "app-fixture");
  // This test makes no GitHub requests. The gateway tests exercise App authentication.
  await writeFile(pem, "inert app fixture");
  const reservation = createServer();
  await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const port = (reservation.address() as AddressInfo).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
  const env = {PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, DATABASE_URL: url.href,
    PERRY_INSTALLATION_ID: "101", PERRY_REPOSITORY_ID: "202", PERRY_PORT: String(port), PERRY_WEBHOOK_SECRET: "fixture",
    PERRY_CACHE_DIR: root, PERRY_APP_KEY_FILE: pem, PERRY_APP_ID: "1", PERRY_BOT_ID: "2"};
  const child = spawn(process.execPath, [entry], {env, windowsHide: true, stdio: ["ignore", "pipe", "ignore"]});
  const closed = once(child, "close");
  try {
    await Promise.race([once(child.stdout, "data"), closed.then(() => { throw new Error("Control exited before startup."); })]);
    const host = "http://127.0.0.1:" + port;
    for (const name of ["live", "ready"]) assert.equal((await fetch(host + "/health/" + name)).status, 200);
    assert.equal((await fetch(host + "/webhooks/github", {method: "POST", body: "{}"})).status, 401);
  } finally { child.kill(); await closed; }
  const scope = JSON.stringify(["101", "202", 9]);
  await admin.query("INSERT INTO " + schema + ".perry_mentions(scope, comment_id, request, state) VALUES ($1, '55', '{}', 'failed')", [scope]);
  const result = await promisify(execFile)(process.execPath, [entry, "--retry", "101", "202", "9", "55"], {env, windowsHide: true});
  assert.match(result.stdout, /Queued the failed request/);
  const state = await admin.query("SELECT state FROM " + schema + ".perry_mentions WHERE scope = $1", [scope]);
  assert.equal(state.rows[0].state, "pending");
});
