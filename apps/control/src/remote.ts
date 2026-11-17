import type { IncomingMessage, ServerResponse } from "node:http";
import type { GitHubGateway } from "./github.ts";
import type { MentionRequest } from "./intake.ts";
import type { PairingStore, RunnerScope } from "./pairing-store.ts";
import type { RemoteStore } from "./remote-store.ts";
import type { Bodies, Refs } from "./worker.ts";
import { setTimeout as sleep } from "node:timers/promises";

export async function awaitRemote(store: RemoteStore, request: MentionRequest, refs: Refs, signal: AbortSignal): Promise<Bodies> {
  const timeout = AbortSignal.timeout(20 * 60_000);
  const deadline = AbortSignal.any([signal, timeout]);
  const id = await store.enqueue(request, refs);
  try {
    while (!deadline.aborted) {
      const result = await store.result(id);
      if (result) return result;
      await sleep(1000, undefined, {signal:deadline});
    }
    throw new Error("Remote assessment expired.");
  } catch (error) {
    if (timeout.aborted && !signal.aborted) await store.cancel(id);
    throw error;
  }
}

export function remoteHandler(pairs: PairingStore, store: RemoteStore,
  github: Pick<GitHubGateway,"authorize"|"refs"|"sourceToken">, scope: RunnerScope) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const reply = (status: number, body?: object) => {
      res.writeHead(status, {"Content-Type":"application/json", "Cache-Control":"no-store"});
      res.end(body && JSON.stringify(body));
    };
    if (req.method !== "POST") return reply(405);
    const bearer = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? "")?.[1];
    const runnerId = bearer && await pairs.identify(scope,bearer);
    if (!runnerId) return reply(401);
    if (req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") return reply(415);
    if (Number(req.headers["content-length"]) > 180_000) return reply(413);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req.iterator({destroyOnReturn:false})) {
      size += chunk.length;
      if (size > 180_000) {res.setHeader("Connection","close"); return reply(413);}
      chunks.push(chunk);
    }
    let input;
    try {input = JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks)));}
    catch {return reply(400);}
    if (!input || typeof input !== "object" || Array.isArray(input)) return reply(400);
    if (req.url === "/runners/jobs/claim") {
      if (Object.keys(input).length) return reply(400);
      const job = await store.claim(scope,runnerId);
      if (!job) return reply(204);
      const signal = AbortSignal.timeout(45_000);
      if (!await github.authorize(job.request, signal)) {await store.cancel(job.jobId); return reply(204);}
      const current = await github.refs(job.request,signal);
      if (!current || current.base !== job.refs.base || current.head !== job.refs.head) {
        await store.cancel(job.jobId);
        return reply(204);
      }
      const sourceToken = await github.sourceToken(job.request,signal);
      if (!await store.heartbeat(scope,runnerId,job.jobId,job.leaseToken)) return reply(409);
      return reply(200,{...job,refs:current,sourceToken});
    }
    const route = /^\/runners\/jobs\/([a-f0-9-]{36})\/(heartbeat|result)$/.exec(req.url ?? "");
    if (!route || typeof input.leaseToken !== "string") return reply(400);
    if (route[2] === "heartbeat") {
      if (Object.keys(input).length !== 1) return reply(400);
      return reply(await store.heartbeat(scope,runnerId,route[1]!,input.leaseToken) ? 204 : 409);
    }
    if (Object.keys(input).length !== 2 || !Object.hasOwn(input,"bodies")) return reply(400);
    return reply(await store.complete(scope,runnerId,route[1]!,input.leaseToken,input.bodies) ? 204 : 409);
  };
}
