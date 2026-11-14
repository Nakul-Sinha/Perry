import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { BlobRead, Revision, Snapshot } from "./contracts.ts";

const execute = promisify(execFile);
const maxBytes = 1024 * 1024;
const maxFiles = 256;
const fullId = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const statuses = { A: "added", M: "modified", D: "deleted", T: "type_changed" } as const;

function safePath(path: string): boolean {
  return !/[\\\x00-\x1f\x7f\uD800-\uDFFF]/u.test(path) && !/^[a-z]:/i.test(path)
    && path.split("/").every(part => part !== "" && part !== "." && part !== ".." && part.toLowerCase() !== ".git");
}

export async function openSnapshot(repo: string, base: string, head: string): Promise<Snapshot> {
  const directory = resolve(repo);
  if (!fullId.test(base) || !fullId.test(head)) {
    throw new Error("Pass full hexadecimal base and head commit IDs.");
  }
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
  async function git(args: string[]): Promise<Buffer> {
    const { stdout } = await execute("git", [
      "--no-pager", "--no-lazy-fetch", "--no-replace-objects", "--literal-pathspecs",
      "-C", directory, ...args,
    ], { env, encoding: "buffer", maxBuffer: maxBytes, timeout: 10000, windowsHide: true });
    return stdout;
  }

  // A tag object and a short SHA in a SHA-256 repository can both resolve to a commit.
  // Require the resolved object itself to match the caller's complete identifier.
  base = base.toLowerCase();
  head = head.toLowerCase();
  try {
    const prefix = await git(["rev-parse", "--show-prefix"]);
    if (prefix.toString().trimEnd() !== "") throw new Error();
    for (const id of new Set([base, head])) {
      const resolved = await git(["rev-parse", "--verify", id + "^{commit}"]);
      if (resolved.toString().trim() !== id) throw new Error();
    }
  } catch {
    throw new Error("Select a local Git repository root with both full commit IDs available.");
  }
  if (base !== head && (await git(["rev-parse", "--is-shallow-repository"])).toString().trim() !== "false") {
    throw new Error("Select a full local history to determine the merge base.");
  }

  const ancestors = await git(["merge-base", "--all", base, head]).catch(() => Buffer.alloc(0));
  const mergeBase = ancestors.toString().trim();
  if (!fullId.test(mergeBase)) throw new Error("The commits require one locally available merge base.");
  const fields = await git([
    "diff-tree", "-r", "-z", "--no-commit-id", "--name-status", "--find-renames=50%", "-l256", "--no-ext-diff",
    "--no-textconv", "--no-relative", "--ignore-submodules=none", mergeBase, head, "--",
  ]).then(bytes => utf8.decode(bytes).split("\0")).catch(() => {
    throw new Error("Cannot read a bounded UTF-8 change list from the local commits.");
  });
  if (fields.pop() !== "") throw new Error("The Git change list is incomplete.");
  const changes: Snapshot["changes"] = [];
  for (let i = 0; i < fields.length;) {
    const code = fields[i++]!;
    const path = fields[i++];
    if (!path || !safePath(path)) throw new Error("The change list contains an unsupported path.");
    if (/^R[0-9]{1,3}$/.test(code)) {
      const destination = fields[i++];
      if (!destination || !safePath(destination)) throw new Error("The renamed path is unsupported.");
      changes.push({ path, status: "deleted" }, { path: destination, previousPath: path, status: "added" });
    } else if (Object.hasOwn(statuses, code)) {
      changes.push({ path, status: statuses[code as keyof typeof statuses] });
    } else {
      throw new Error("The change list contains an unsupported status or path.");
    }
    if (changes.length > maxFiles) throw new Error("The change list exceeds " + maxFiles + " paths.");
  }

  const refs = { base, head, merge_base: mergeBase };
  async function read(ref: Revision, path: string): Promise<BlobRead> {
    if (!Object.hasOwn(refs, ref) || !safePath(path)) {
      return { kind: "unavailable", reason: "Unsafe source path or unrecognized revision." };
    }
    try {
      const listing = utf8.decode(await git(["ls-tree", "--full-tree", "-lz", refs[ref], "--", path]));
      if (!listing) return { kind: "missing" };
      const [metadata, name] = listing.split("\t");
      const [mode, type, oid, size] = metadata!.trim().split(/\s+/);
      if (name !== path + "\0" || type !== "blob" || (mode !== "100644" && mode !== "100755") || !oid || !fullId.test(oid)) {
        return { kind: "unavailable", reason: "The requested entry is not a regular file." };
      }
      if (!size || !/^\d+$/.test(size) || Number(size) > maxBytes) {
        return { kind: "unavailable", reason: "The source blob exceeds the 1 MiB read budget." };
      }
      const content = await git(["cat-file", "blob", oid]);
      const text = utf8.decode(content);
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) {
        return { kind: "unavailable", reason: "The source blob contains binary data." };
      }
      return { kind: "text", text };
    } catch {
      return { kind: "unavailable", reason: "The Git entry could not be read as bounded UTF-8 text." };
    }
  }
  async function listPaths(ref: Revision): Promise<string[]> {
    const names = utf8.decode(await git(["ls-tree", "-rz", "--full-tree", "--name-only", refs[ref]])).split("\0");
    if (names.pop() !== "" || names.length > 30_000) throw new Error("Source inventory exceeds the local limit.");
    return names.filter(safePath);
  }
  return { ...refs, changes, read, listPaths };
}
