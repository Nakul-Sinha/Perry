import { lstat, open, realpath, unlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import type { PairingStore } from "./pairing-store.ts";

type Scope = { installationId: string; repoId: string };
const credential = /^[A-Za-z0-9_-]{43}$/;

const fileMessages = {
  platform: "Use a POSIX host such as WSL to create a private pairing file.",
  directory: "Select an owner-only pairing directory (chmod 700) under owner-controlled directories without symbolic links.",
  destination: "Choose an unused pairing file in a writable private directory.",
  issue: "Could not issue the pairing code. Check the control database and try again.",
  write: "Could not save the pairing code. Check the private directory and available disk space.",
} as const;

export class PairingFileError extends Error {
  constructor(reason: keyof typeof fileMessages) { super(fileMessages[reason]); }
}

export async function issueCodeFile(store: Pick<PairingStore, "issue">, scope: Scope, path: string) {
  if (!process.getuid) throw new PairingFileError("platform");
  if (!path.trim() || path.trim() !== path || /[\p{Cc}\p{Cf}]/u.test(path)) throw new PairingFileError("destination");
  const owner = process.getuid();
  const destination = resolve(path);
  const parent = dirname(destination);
  try {
    if (await realpath(parent) !== parent) throw new Error();
    for (let directory = parent;; directory = dirname(directory)) {
      const stat = await lstat(directory);
      if (!stat.isDirectory()) throw new Error();
      if (directory === parent) {
        if (stat.uid !== owner || (stat.mode & 0o077)) throw new Error();
      } else {
        if (stat.uid !== 0 && stat.uid !== owner) throw new Error();
        if ((stat.mode & 0o022) && !(stat.uid === 0 && (stat.mode & 0o1000))) throw new Error();
      }
      if (dirname(directory) === directory) break;
    }
  } catch { throw new PairingFileError("directory"); }
  const file = await open(destination, "wx", 0o600).catch(() => { throw new PairingFileError("destination"); });
  try {
    const issued = await store.issue(scope).catch(() => { throw new PairingFileError("issue"); });
    await file.writeFile(issued.code + "\n", "utf8");
    await file.sync();
  } catch (error) {
    const ours = await file.stat();
    const named = await lstat(destination).catch(() => undefined);
    if (named && ours.dev === named.dev && ours.ino === named.ino) await unlink(destination);
    throw error instanceof PairingFileError ? error : new PairingFileError("write");
  } finally { await file.close(); }
}

export function runnerHandler(store: PairingStore, scope: Scope) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const reply = (code: number, value?: object) => {
      res.writeHead(code, {"Content-Type": "application/json", "Cache-Control": "no-store"});
      res.end(value && JSON.stringify(value));
    };
    if (req.url === "/runners/me") {
      if (req.method !== "GET") return reply(405);
      const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? "")?.[1];
      if (!token) return reply(401);
      const runnerId = await store.identify(scope, token);
      if (!runnerId) return reply(401);
      return reply(200, {runnerId, ...scope});
    }
    if (req.url !== "/runners/pair") return reply(404);
    if (req.method !== "POST") return reply(405);
    if (req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") return reply(415);
    if (Number(req.headers["content-length"]) > 1024) return reply(413);
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of req.iterator({destroyOnReturn: false})) {
      length += chunk.length;
      if (length > 1024) {
        res.setHeader("Connection", "close");
        return reply(413);
      }
      chunks.push(chunk);
    }
    let input;
    try { input = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(Buffer.concat(chunks))); }
    catch { return reply(400); }
    if (!input || typeof input.code !== "string" || !credential.test(input.code) || Object.keys(input).length !== 1) return reply(400);
    const runner = await store.pair(scope, input.code);
    if (!runner) return reply(401);
    return reply(201, {...runner, ...scope});
  };
}
