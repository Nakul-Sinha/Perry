import { constants } from "node:fs";
import { open, lstat, realpath, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

const valuePattern = /^[A-Za-z0-9_-]{43}$/;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const scopeId = /^[1-9]\d{0,19}$/;
const maxBytes = 4096;
type Registration = { runnerId: string; installationId: string; repoId: string };
type Identity = Registration & { origin: string; token: string };

function origin(input: unknown): string {
  const invalid = new Error("Specify an HTTPS origin or an HTTP loopback address without a path.");
  if (typeof input !== "string" || /[\s\\?#@]/u.test(input)) throw invalid;
  let url: URL;
  try { url = new URL(input); } catch { throw invalid; }
  if ((input !== url.origin && input !== url.origin + "/") || (url.protocol !== "https:" &&
    !(url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname)))) throw invalid;
  return url.origin;
}

function registration(value: unknown): Registration {
  if (value && typeof value === "object" && "runnerId" in value && typeof value.runnerId === "string" && uuid.test(value.runnerId)
    && "repoId" in value && typeof value.repoId === "string" && scopeId.test(value.repoId)
    && "installationId" in value && typeof value.installationId === "string" && scopeId.test(value.installationId)) {
    return {runnerId: value.runnerId, repoId: value.repoId, installationId: value.installationId};
  }
  throw new Error("Invalid runner registration.");
}

function identity(value: unknown, expectedOrigin?: string): Identity {
  const scoped = registration(value);
  if (!value || typeof value !== "object" || !("token" in value) || typeof value.token !== "string" || !valuePattern.test(value.token)) {
    throw new Error("Invalid runner identity.");
  }
  const server = expectedOrigin ?? origin("origin" in value ? value.origin : undefined);
  return {...scoped, origin:server, token:value.token};
}

async function request(server: string, path: string, init: RequestInit): Promise<unknown> {
  try {
    const res = await fetch(server + path, {...init, redirect:"error", signal:AbortSignal.timeout(10_000)});
    if (!res.ok || !res.body || !/^application\/json(?:\s*;|$)/i.test(res.headers.get("content-type") ?? "")
      || Number(res.headers.get("content-length")) > maxBytes) {
      await res.body?.cancel();
      throw new Error();
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const {value, done} = await reader.read();
        if (done) break;
        size += value.length;
        if (size > maxBytes) { await reader.cancel(); throw new Error(); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    return JSON.parse(new TextDecoder("utf-8", {fatal:true}).decode(Buffer.concat(chunks)));
  } catch { throw new Error("Perry control did not confirm the runner request."); }
}

async function privatePath(input: string): Promise<string> {
  if (!input.trim() || input !== input.trim() || /[\p{Cc}\p{Cf}]/u.test(input)) throw new Error("Invalid credential file path.");
  const path = resolve(input);
  const owner = process.getuid!();
  try {
    const parent = dirname(path);
    if (await realpath(parent) !== parent) throw new Error();
    for (let directory = parent;; directory = dirname(directory)) {
      const stat = await lstat(directory);
      if (!stat.isDirectory() || (directory === parent ? stat.uid !== owner : stat.uid !== 0 && stat.uid !== owner)) throw new Error();
      // A sticky system temporary directory may contain a private child.
      if ((stat.mode & 0o022) && !(directory !== parent && stat.uid === 0 && (stat.mode & 0o1000))) throw new Error();
      if (directory === dirname(directory)) break;
    }
  } catch { throw new Error("Use existing owner-controlled directories without symbolic links for runner credentials."); }
  return path;
}

async function readPrivate(path: string): Promise<string> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid!() || (stat.mode & 0o077) || stat.size > maxBytes) throw new Error();
      const buffer = Buffer.alloc(maxBytes + 1);
      let total = 0;
      while (total < buffer.length) {
        const {bytesRead} = await file.read(buffer, total, buffer.length - total);
        if (!bytesRead) break;
        total += bytesRead;
      }
      if (total > maxBytes) throw new Error();
      return new TextDecoder("utf-8", {fatal:true}).decode(buffer.subarray(0,total));
    } finally { await file.close(); }
  } catch { throw new Error("Use an owner-only regular credential file (chmod 600) without links."); }
}

export async function runPairCommand(args: string[]): Promise<void> {
  const usage = "Use pair --server ORIGIN --code-file PATH --identity PATH or pair-status --identity PATH [--server ORIGIN].";
  let values;
  try {
    const result = parseArgs({args:args.slice(1), tokens:true, options: {
      server:{type:"string"}, identity:{type:"string"}, "code-file":{type:"string"},
    }});
    const names = result.tokens.map(t => t.kind === "option" ? t.name : "");
    values = result.values;
    if (!values.identity || names.length !== new Set(names).size || (args[0] === "pair"
      ? !values["code-file"] || !values.server : args[0] !== "pair-status" || values["code-file"] !== undefined)) throw new Error();
  } catch { throw new Error(usage); }
  const server = values.server === undefined ? undefined : origin(values.server);
  if (process.platform === "win32" || !process.getuid || !constants.O_NOFOLLOW) {
    throw new Error("Runner identities require POSIX file permissions. On Windows, use Linux files inside WSL.");
  }
  const path = await privatePath(values.identity);
  let runner: Registration;
  if (args[0] === "pair") {
    const code = (await readPrivate(await privatePath(values["code-file"]!))).replace(/\r?\n$/, "");
    if (code.length !== 43 || !valuePattern.test(code)) throw new Error("The pairing code file has an invalid format.");
    // Reserve the name before spending the single-use code. A competing
    // enrollment or an existing file must never lose its identity.
    const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      .catch(() => { throw new Error("Choose an unused identity file in a writable private directory."); });
    try {
      const response = await request(server!, "/runners/pair", {
        method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({code}),
      });
      const saved = identity(response, server);
      await file.writeFile(JSON.stringify(saved) + "\n");
      await file.sync();
      runner = saved;
    } catch (error) {
      // Cleanup only our reservation; do not unlink a replacement file.
      const ours = await file.stat();
      const named = await lstat(path).catch(() => undefined);
      if (named && ours.dev === named.dev && ours.ino === named.ino) await unlink(path);
      throw error;
    } finally { await file.close(); }
  } else {
    let parsed: unknown;
    try { parsed = JSON.parse(await readPrivate(path)); } catch { throw new Error("Cannot read a private runner identity."); }
    const saved = identity(parsed);
    if (server && server !== saved.origin) throw new Error("The supplied server differs from the enrolled origin.");
    runner = registration(await request(saved.origin, "/runners/me", {headers:{Authorization:"Bearer " + saved.token}}));
    if (saved.runnerId !== runner.runnerId || saved.repoId !== runner.repoId || saved.installationId !== runner.installationId) {
      throw new Error("The server returned a different runner or repository scope.");
    }
  }
  console.log("Runner " + runner.runnerId + " paired with installation " + runner.installationId + ", repository " + runner.repoId + ".");
}
