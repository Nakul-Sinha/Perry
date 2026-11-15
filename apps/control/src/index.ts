import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Pool } from "pg";
import { prepareCache } from "./cache.ts";
import { GitHubGateway } from "./github.ts";
import { webhookHandler } from "./intake.ts";
import { approvedCheck, runLocal } from "./local-runner.ts";
import { Store } from "./store.ts";
import { checkReview, processMention } from "./worker.ts";

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error("Configure " + name + " before starting Perry.");
  return value;
}

async function main() {
  const installation = required("PERRY_INSTALLATION_ID");
  const repository = required("PERRY_REPOSITORY_ID");
  const args = process.argv.slice(2);
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
  const cache = resolve(required("PERRY_CACHE_DIR"));
  const signingSecret = required("PERRY_WEBHOOK_SECRET");
  const model = process.env.PERRY_ANTHROPIC_MODEL;
  const check = approvedCheck(process.env.PERRY_TEST_PATH, process.env.PERRY_TEST_MODULE);
  const port = Number(process.env.PERRY_PORT ?? "3000");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PERRY_PORT.");
  if (![installation, repository].every(id => /^[1-9]\d*$/.test(id))) throw new Error("Invalid repository or installation ID.");
  const github = new GitHubGateway({
    appId: required("PERRY_APP_ID"), botId: required("PERRY_BOT_ID"),
    privateKey: await readFile(required("PERRY_APP_KEY_FILE"), "utf8"),
  });
  const pool = new Pool({ connectionString: required("DATABASE_URL"), max: 6, connectionTimeoutMillis: 4000, statement_timeout: 5000 });
  pool.on("error", () => console.error("An idle database connection closed."));
  const store = new Store(pool);
  await store.init();
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
    void intake(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", done); });
  console.log("Perry control listening on 127.0.0.1:" + port);
  let stopping = false;
  const stop = () => { stopping = true; server.close(); };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  const scope = {installationId: installation, repoId: repository};
  let nextPoll = 0;
  try {
    while (!stopping) {
      try {
        const active = await store.workOne(async (request, job) => {
          return processMention(request, job, github, async (r, refs, signal) => {
            const token = await github.sourceToken(r, signal);
            const repo = await prepareCache(cache, r, refs, token, signal);
            return runLocal(repo, r, refs, signal, model, check);
          });
        }, scope);
        if (Date.now() >= nextPoll) {
          nextPoll = Date.now() + 5000;
          await store.pollOne(scope, watch => checkReview(watch, github));
        }
        if (!active) await sleep(500);
      } catch {
        console.error("The queue worker lost its connection. Retrying.");
        await sleep(2000);
      }
    }
  } finally { server.close(); await pool.end(); }
}

main().catch(error => {
  const message = error instanceof Error && error.message.startsWith("Configure PERRY_") ? error.message : "Perry control could not start. Check the database, App configuration and port.";
  console.error(message);
  process.exitCode = 1;
});
