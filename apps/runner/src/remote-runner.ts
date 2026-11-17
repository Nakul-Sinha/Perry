import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { privateCacheDirectory, readRunnerIdentity, type Identity } from "./pair-cli.ts";

type Request = {
  installationId: string; repoId: string; owner: string; repo: string; number: number;
  isPR: boolean; kind: "review" | "question"; text: string;
};
type Refs = {base: string; head: string; sameRepository?: boolean};
type Lease = {jobId: string; leaseToken: string; sourceToken: string; request: Request; refs: Refs};
type Bodies = {summary: string; findings: string} | {answer: string};
type Assess = (job: Lease, signal: AbortSignal) => Promise<Bodies>;
type Pause = (ms: number, signal: AbortSignal) => Promise<void>;
const pause: Pause = (ms, signal) => sleep(ms, undefined, {signal});
const validSha = /^[a-f0-9]{40}$/;
const uuid = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const record = (v: unknown): v is Record<string,unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function lease(value: unknown, id: Identity): Lease {
  const invalid = new Error("The control service returned an invalid or out-of-scope job.");
  if (!record(value) || !record(value.request) || !record(value.refs)) throw invalid;
  const {request: r, refs, jobId, leaseToken, sourceToken} = value;
  if (typeof jobId !== "string" || !uuid.test(jobId) || typeof leaseToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(leaseToken)
    || typeof sourceToken !== "string" || !/^[!-~]{1,4096}$/.test(sourceToken)
    || r.installationId !== id.installationId || r.repoId !== id.repoId || typeof r.owner !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(r.owner) || typeof r.repo !== "string" || !/^[A-Za-z0-9_.-]{1,100}$/.test(r.repo)
    || r.repo === "." || r.repo === ".." || typeof r.number !== "number" || !Number.isSafeInteger(r.number) || r.number < 1
    || typeof r.isPR !== "boolean" || (r.kind !== "review" && r.kind !== "question") || (r.kind === "review" && !r.isPR)
    || typeof r.text !== "string" || !r.text.trim() || r.text.length > 16384 || r.text.includes("\0")
    || typeof refs.base !== "string" || !validSha.test(refs.base) || typeof refs.head !== "string" || !validSha.test(refs.head)
    || (refs.sameRepository !== undefined && typeof refs.sameRepository !== "boolean")
    || (!r.isPR && (refs.base !== refs.head || refs.sameRepository === true))) throw invalid;
  return {jobId,leaseToken,sourceToken, request:{installationId:id.installationId, repoId:id.repoId,
    owner:r.owner, repo:r.repo, number:r.number, kind:r.kind, isPR:r.isPR, text:r.text},
    refs:{base:refs.base, head:refs.head, sameRepository:refs.sameRepository === true}};
}

class Revoked extends Error {
  constructor() { super("The runner identity was rejected. Check its registration with the control operator."); }
}

async function post(id: Identity, route: string, body: object, signal: AbortSignal, timeout = 10_000) {
  const response = await fetch(id.origin + "/runners/jobs/" + route, {method:"POST", redirect:"error",
    headers:{Authorization:"Bearer " + id.token, "Content-Type":"application/json"}, body:JSON.stringify(body),
    signal:AbortSignal.any([signal, AbortSignal.timeout(timeout)])});
  if (response.status === 401 || response.status === 403) {await response.body?.cancel(); throw new Revoked();}
  return response;
}

async function parseClaim(response: Response): Promise<unknown> {
  const limit = 128 * 1024;
  if (response.status !== 200 || !response.body || !/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")
    || Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    throw new Error("The control service could not provide a job.");
  }
  let total = 0;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const {done,value} = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit) { await reader.cancel(); throw new Error("Job exceeds the payload limit."); }
      chunks.push(value);
    }
  } finally {reader.releaseLock();}
  return JSON.parse(new TextDecoder("utf-8", {fatal:true}).decode(Buffer.concat(chunks)));
}

function checkedBodies(value: unknown, job: Lease, id: Identity): Bodies {
  const keys = job.request.kind === "review" ? ["summary", "findings"] : ["answer"];
  if (!record(value) || Object.keys(value).length !== keys.length || !keys.every(k => {
    const text = value[k];
    return typeof text === "string" && !!text.trim() && Buffer.byteLength(text) <= 58_000
      && ![id.token, job.leaseToken, job.sourceToken].some(secret => text.includes(secret));
  }) || Buffer.byteLength(JSON.stringify({leaseToken:job.leaseToken, bodies:value})) > 180_000) throw new Error("Invalid result.");
  return value as Bodies;
}

async function submit(id: Identity, job: Lease, bodies: Bodies, signal: AbortSignal, wait: Pause) {
  const receipt = {leaseToken:job.leaseToken, bodies};
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await wait(500 * attempt, signal);
    signal.throwIfAborted();
    let status: number;
    try {
      const res = await post(id, job.jobId + "/result", receipt, signal);
      status = res.status;
      await res.body?.cancel();
    } catch (error) {
      if (error instanceof Revoked) throw error;
      signal.throwIfAborted();
      continue;
    }
    if (status === 204) return;
    if (status < 500 && ![408, 425, 429].includes(status)) break;
  }
  throw new Error("The control service did not accept the result.");
}

export async function runRemoteOnce(id: Identity, signal: AbortSignal, assess: Assess, wait: Pause = pause): Promise<boolean> {
  const claimed = await post(id, "claim", {}, signal, 60_000);
  if (claimed.status === 204) return false;
  const job = lease(await parseClaim(claimed), id);
  const ending = new AbortController();
  const active = AbortSignal.any([signal, ending.signal]);
  const path = job.jobId + "/";
  let rejected = false;
  const beat = (async () => {
    try {
      while (!active.aborted) {
        await wait(15_000, active);
        active.throwIfAborted();
        const res = await post(id, path + "heartbeat", {leaseToken:job.leaseToken}, active);
        await res.body?.cancel();
        if (res.status !== 204) throw new Error("Lease expired.");
      }
    } catch (error) {
      if (error instanceof Revoked) rejected = true;
      ending.abort();
    }
  })();
  try {
    let bodies: Bodies;
    try { bodies = checkedBodies(await assess(job, active), job, id); }
    catch {
      active.throwIfAborted();
      bodies = job.request.kind === "review" ? {
        summary:"## Perry review\n\n**HOLD | 0/10 merge readiness (provisional)**\n\nThe paired runner could not finish the assessment.",
        findings:"## Bugs and suggested fixes\n\nThe assessment is incomplete. Request another review to retry.",
      } : {answer:"## Perry answer\n\nThe paired runner could not assess the requested source. Ask again to retry."};
    }
    active.throwIfAborted();
    await submit(id, job, bodies, active, wait);
    return true;
  } finally {
    ending.abort();
    await beat;
    if (rejected) throw new Revoked();
  }
}

export async function runRemote(args: string[]): Promise<void> {
  const usage = "Use serve --identity PATH --cache DIR with an optional model and --test PATH [--module PATH].";
  let values;
  try {
    const result = parseArgs({args:args.slice(1), tokens:true, options:{
      identity:{type:"string"}, cache:{type:"string"}, test:{type:"string"}, module:{type:"string"},
      "anthropic-model":{type:"string"}, "openai-model":{type:"string"}, "opencode-chat-model":{type:"string"},
    }});
    const names = result.tokens.map(t => t.kind === "option" ? t.name : "");
    values = result.values;
    if (args[0] !== "serve" || !values.identity || !values.cache || names.length !== new Set(names).size) throw new Error();
  } catch {throw new Error(usage);}
  // Load the matching trusted workspace entry points in both source and dist.
  const target = import.meta.url.endsWith(".ts") ? "src" : "dist";
  const suffix = target === "src" ? "ts" : "js";
  const sibling = (file: string) => new URL("../../control/" + target + "/" + file + "." + suffix, import.meta.url).href;
  const {prepareCache} = await import(sibling("cache"));
  const {runLocal, approvedModel, approvedCheck} = await import(sibling("local-runner"));
  const model = approvedModel({PERRY_ANTHROPIC_MODEL:values["anthropic-model"], PERRY_OPENAI_MODEL:values["openai-model"],
    PERRY_OPENCODE_CHAT_MODEL:values["opencode-chat-model"]});
  const check = approvedCheck(values.test, values.module);
  const id = await readRunnerIdentity(values.identity);
  const cache = await privateCacheDirectory(values.cache);
  const stop = new AbortController();
  const shutdown = () => stop.abort();
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    while (!stop.signal.aborted) {
      let delay = 0;
      try {
        const worked = await runRemoteOnce(id, stop.signal, async (job, signal) => {
          const repo = await prepareCache(cache, job.request, job.refs, job.sourceToken, signal);
          signal.throwIfAborted();
          return runLocal(repo, job.request, job.refs, signal, model, check);
        });
        if (!worked) delay = 2000;
      } catch (error) {
        if (stop.signal.aborted) break;
        if (error instanceof Revoked) throw error;
        console.error("The runner request did not finish. Retrying.");
        delay = 5000;
      }
      if (delay) await pause(delay, stop.signal).catch(() => {});
    }
  } finally {
    process.removeListener("SIGINT", shutdown);
    process.removeListener("SIGTERM", shutdown);
  }
}
