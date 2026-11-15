import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { MentionRequest } from "./intake.ts";

type RunGit = (dir: string, args: string[], env: NodeJS.ProcessEnv, signal: AbortSignal) => Promise<string>;
const hardening = [
  "--no-pager", "--no-replace-objects", "--no-lazy-fetch", "-c", "core.hooksPath=/dev/null",
  "-c", "credential.helper=", "-c", "http.followRedirects=false", "-c", "http.lowSpeedLimit=1024",
  "-c", "http.lowSpeedTime=30", "-c", "core.filesRefLockTimeout=5000",
];

// The service operator owns the cache root. Test and model processes must never
// mount this directory. Put the cache on a quota-limited volume for a disk cap.
const runGit: RunGit = (dir, args, env, signal) => new Promise((done, fail) => {
  signal.throwIfAborted();
  const detached = process.platform !== "win32";
  const child = spawn("git", args, { cwd: dir, env, detached, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  let output = "";
  let oversized = false;
  const stop = () => {
    if (!child.pid) return;
    if (detached) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* The group has exited. */ }
    } else {
      // Windows Git fetch starts a separate HTTPS helper.
      const kill = spawn(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
        ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
      kill.on("error", () => child.kill());
    }
  };
  signal.addEventListener("abort", stop, {once: true});
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    if (output.length + chunk.length > 4096) { oversized = true; stop(); }
    else output += chunk;
  });
  child.once("error", () => {
    signal.removeEventListener("abort", stop);
    fail(new Error("Git could not start in the review cache."));
  });
  child.once("close", code => {
    signal.removeEventListener("abort", stop);
    if (code || code === null || oversized || signal.aborted) fail(new Error("Review cache Git operation failed."));
    else done(output.trim());
  });
});

async function directory(path: string) {
  if (!(await lstat(path)).isDirectory()) throw new Error("Review cache path must be a directory.");
}

async function exists(path: string) {
  try { await lstat(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function prepareCache(root: string, r: MentionRequest, refs: {base: string; head: string},
  token: string, signal: AbortSignal, execute: RunGit = runGit): Promise<string> {
  const ids = /^[1-9]\d{0,19}$/;
  if (!ids.test(r.installationId) || !ids.test(r.repoId) || !Number.isSafeInteger(r.number) || r.number < 1
    || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(r.owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(r.repo)
    || r.repo === "." || r.repo === ".." || !token || !/^[a-f0-9]{40}$/.test(refs.base) || !/^[a-f0-9]{40}$/.test(refs.head)) {
    throw new Error("Invalid review cache scope or commit.");
  }
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
  deadline.throwIfAborted();
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_ATTR_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "https" };
  const cacheRoot = resolve(root);
  const scope = join(cacheRoot, r.installationId);
  const repo = join(scope, r.repoId + ".git");
  const config = "[core]\n\trepositoryformatversion = 0\n\tbare = true\n[gc]\n\tauto = 0\n";
  await mkdir(cacheRoot, {recursive: true, mode: 0o700});
  await directory(cacheRoot);
  await mkdir(scope, {recursive: true, mode: 0o700});
  await directory(scope);
  if (!(await exists(repo))) {
    const scratch = await mkdtemp(join(scope, ".initializing-"));
    try {
      await execute(scratch, [...hardening, "init", "--bare", "--object-format=sha1", "--template=", "."], env, deadline);
      await writeFile(join(scratch, "config"), config);
      try { await rename(scratch, repo); }
      catch (error) { if (!(await exists(repo))) throw error; }
    } finally {
      await rm(scratch, {recursive: true, force: true});
    }
  }
  await directory(repo);
  if (await readFile(join(repo, "config"), "utf8") !== config) throw new Error("Unexpected review cache configuration.");

  const url = "https://github.com/" + r.owner + "/" + r.repo + ".git";
  const auth = { ...env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http." + url + ".extraHeader",
    GIT_CONFIG_VALUE_0: "Authorization: Basic " + Buffer.from("x-access-token:" + token).toString("base64") };
  const fetchRef = (ref: string) => execute(repo, [...hardening, "fetch", "--no-tags", "--no-write-fetch-head",
    "--no-recurse-submodules", "--no-auto-maintenance", "--no-progress", url, ref], auth, deadline);
  async function hasCommit(sha: string) {
    try { return await execute(repo, [...hardening, "cat-file", "-t", sha], env, deadline) === "commit"; }
    catch { deadline.throwIfAborted(); return false; }
  }
  for (const sha of new Set([refs.base, refs.head])) {
    if (!(await hasCommit(sha))) {
      try { await fetchRef(sha); }
      catch {
        deadline.throwIfAborted();
        if (!r.isPR || sha !== refs.head) throw new Error("The pinned commit could not be fetched.");
        await fetchRef("refs/pull/" + r.number + "/head");
      }
      if (!(await hasCommit(sha))) throw new Error("Fetched history does not contain the pinned commit.");
    }
    await execute(repo, [...hardening, "update-ref", "refs/perry/commits/" + sha, sha], env, deadline);
  }
  return repo;
}
