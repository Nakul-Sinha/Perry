import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Pool } from "pg";
import { prepareCache } from "./cache.ts";
import { GitHubGateway } from "./github.ts";
import { webhookHandler } from "./intake.ts";
import { approvedCheck, approvedModel, runLocal } from "./local-runner.ts";
import { Store } from "./store.ts";
import { checkReview, processMention } from "./worker.ts";
import { PairingStore } from "./pairing-store.ts";
import { issueCodeFile, PairingFileError, runnerHandler } from "./pairing.ts";
import { RemoteStore } from "./remote-store.ts";
import { awaitRemote, remoteHandler } from "./remote.ts";
import { UsageStore } from "./usage-store.ts";
import { assessmentAdmission, dailyAssessmentLimit } from "./assessment-budget.ts";

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error("Configure " + name + " before starting Perry.");
  return value;
}

async function main() {
  const installation = required("PERRY_INSTALLATION_ID");
  const repository = required("PERRY_REPOSITORY_ID");
  if (![installation, repository].every(id => /^[1-9]\d{0,19}$/.test(id))) throw new Error("Invalid repository or installation ID.");
  const scope = {installationId: installation, repoId: repository};
  const args = process.argv.slice(2);
  if (args[0] === "--usage") {
    if (args.length !== 1) throw new Error("Configure PERRY_INSTALLATION_ID and PERRY_REPOSITORY_ID, then run --usage without arguments.");
    const limit = dailyAssessmentLimit(process.env.PERRY_DAILY_ASSESSMENT_LIMIT);
    const pool = new Pool({connectionString: required("DATABASE_URL"), connectionTimeoutMillis: 4000});
    try {
      const usage = new UsageStore(pool);
      await usage.init();
      const totals = await usage.totals(scope);
      console.log("UTC day: " + totals.date + "\nAdmitted assessments: " + totals.used
        + "\nDaily limit: " + (limit ?? "unlimited") + "\nCounts include admissions while a limit is enabled.");
    } finally { await pool.end(); }
    return;
  }
  if (args[0] === "--issue-pairing" || args[0] === "--revoke-runner") {
    if (args.length !== 2 || !args[1]) throw new Error("Provide a destination file or runner ID.");
    const pool = new Pool({connectionString: required("DATABASE_URL"), connectionTimeoutMillis: 4000});
    try {
      const pairs = new PairingStore(pool);
      await pairs.init();
      if (args[0] === "--issue-pairing") {
        await issueCodeFile(pairs, scope, args[1]);
        console.log("Wrote a single-use pairing code valid for ten minutes.");
      } else {
        const revoked = await pairs.revoke(scope, args[1]);
        console.log(revoked ? "Revoked the runner." : "No active matching runner.");
        if (!revoked) process.exitCode = 1;
      }
    } finally { await pool.end(); }
    return;
  }
  if (args.length) {
    const [flag, scope, repoId, number, comment] = args;
    if (args.length !== 5 || flag !== "--retry" || scope !== installation || repoId !== repository
      || !/^[1-9]\d*$/.test(number!) || !Number.isSafeInteger(Number(number)) || !/^[1-9]\d*$/.test(comment!)) {
      throw new Error("Configure PERRY_INSTALLATION_ID and PERRY_REPOSITORY_ID to match --retry INSTALLATION_ID REPOSITORY_ID ISSUE_NUMBER COMMENT_ID.");
    }
    const pool = new Pool({connectionString: required("DATABASE_URL"), connectionTimeoutMillis: 4000});
    try {
      const retried = await new Store(pool).retryFailed(installation, repository, Number(number), comment!);
      console.log(retried ? "Queued the failed request." : "No matching failed request.");
      if (!retried) process.exitCode = 1;
    } finally { await pool.end(); }
    return;
  }
  const limit = dailyAssessmentLimit(process.env.PERRY_DAILY_ASSESSMENT_LIMIT);
  const model = approvedModel(process.env);
  const execution = process.env.PERRY_EXECUTION_MODE ?? "local";
  if (!["local","remote"].includes(execution)) throw new Error("Configure PERRY_EXECUTION_MODE as local or remote.");
  if (execution === "remote" && (model || process.env.PERRY_TEST_PATH || process.env.PERRY_TEST_MODULE)) {
    throw new Error("Configure PERRY_EXECUTION_MODE remote with model and check settings on the paired runner.");
  }
  const cache = execution === "local" ? resolve(required("PERRY_CACHE_DIR")) : "";
  const signingSecret = required("PERRY_WEBHOOK_SECRET");
  const check = approvedCheck(process.env.PERRY_TEST_PATH, process.env.PERRY_TEST_MODULE);
  const port = Number(process.env.PERRY_PORT ?? "3000");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PERRY_PORT.");
  const github = new GitHubGateway({
    appId: required("PERRY_APP_ID"), botId: required("PERRY_BOT_ID"),
    privateKey: await readFile(required("PERRY_APP_KEY_FILE"), "utf8"),
  });
  const pool = new Pool({ connectionString: required("DATABASE_URL"), max: 6, connectionTimeoutMillis: 4000, statement_timeout: 5000 });
  pool.on("error", () => console.error("An idle database connection closed."));
  const store = new Store(pool);
  await store.init();
  const usage = new UsageStore(pool);
  if (limit !== undefined) await usage.init();
  const pairs = new PairingStore(pool);
  await pairs.init();
  const runners = runnerHandler(pairs, scope);
  const remote = new RemoteStore(pool);
  await remote.init();
  const jobs = remoteHandler(pairs,remote,github,scope);
  const intake = webhookHandler(signingSecret, async (delivery, request) => {
    if (request.installationId === installation && request.repoId === repository) await store.accept(delivery, request);
  });
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health/live") { res.writeHead(200).end("ok"); return; }
    if (req.method === "GET" && req.url === "/health/ready") {
      void pool.query("SELECT 1").then(
        () => res.writeHead(200).end("ready"),
        () => res.writeHead(503).end("unavailable"),
      );
      return;
    }
    const handler = req.url?.startsWith("/runners/jobs/") ? jobs : req.url?.startsWith("/runners/") ? runners : intake;
    void handler(req, res).catch(() => { if (!res.headersSent) res.writeHead(503, {"Cache-Control": "no-store"}); res.end(); });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", done); });
  console.log("Perry control listening on 127.0.0.1:" + port);
  let stopping = false;
  const shutdown = new AbortController();
  const stop = () => { stopping = true; shutdown.abort(); server.close(); };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  const maintenance = async () => {
    while (!stopping) {
      try { await store.pollOne(scope, watch => checkReview(watch, github)); }
      catch { if (!stopping) console.error("Review freshness checking will retry."); }
      await sleep(5000, undefined, {signal:shutdown.signal}).catch(() => {});
    }
  };
  const work = async () => {
    while (!stopping) {
      try {
        const active = await store.workOne(async (request, job) => {
          const currentJob = {...job, signal: AbortSignal.any([job.signal, shutdown.signal])};
          return processMention(request, currentJob, github, async (r, refs, signal) => {
            const denied = await assessmentAdmission(usage, r, refs, limit, signal);
            if (denied) return denied;
            if (execution === "remote") return awaitRemote(remote,r,refs,signal);
            const token = await github.sourceToken(r, signal);
            const repo = await prepareCache(cache, r, refs, token, signal);
            return runLocal(repo, r, refs, signal, model, check);
          });
        }, scope);
        if (!active) await sleep(500);
      } catch {
        console.error("The queue worker lost its connection. Retrying.");
        await sleep(2000);
      }
    }
  };
  try { await Promise.all([work(), work(), maintenance()]); }
  finally { stop(); await pool.end(); }
}

main().catch(error => {
  const message = error instanceof PairingFileError || error instanceof Error && error.message.startsWith("Configure PERRY_") ? error.message : "Perry control could not start. Check the database, App configuration and port.";
  console.error(message);
  process.exitCode = 1;
});
