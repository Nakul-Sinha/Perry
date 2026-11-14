import type { Revision, Snapshot } from "./contracts.ts";
import type { ContextFile } from "./model-review.ts";

const code = /\.(?:[cm]?[jt]sx?|py|go|rs)$/i;
const plan = /^(?:docs\/(?:plans?\/|adr\/)[^/]+|docs\/(?:plan|project idea)|(?:plan|project idea))\.md$/i;
const excluded = /(?:^|\/)(?:\.|node_modules\/|dist\/|build\/|coverage\/|vendor\/|generated\/)|(?:^|[\/._-])(?:credentials?|secrets?|private[-_]?key)(?:[\/._-]|$)/i;
const sensitive = /-----BEGIN [^-\n]*PRIVATE KEY-----|\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{25,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16})\b/;

export async function collectContext(snapshot: Snapshot) {
  const files: ContextFile[] = [];
  const paths = new Set<string>();
  const limitations = new Set<string>();
  let remaining = 48 * 1024;
  async function add(ref: Revision, path: string, changed: boolean) {
    const key = ref + ":" + path;
    if (paths.has(key) || excluded.test(path) || !(code.test(path) || plan.test(path))) return;
    paths.add(key);
    if (files.length >= 24 || remaining <= 0) {
      limitations.add("Some files exceeded the model context budget.");
      return;
    }
    const blob = await snapshot.read(ref, path);
    if (blob.kind !== "text") return;
    const size = Buffer.byteLength(blob.text);
    if (size > 12 * 1024 || size > remaining || sensitive.test(blob.text)) {
      limitations.add("Some source was withheld by the size or sensitive-content filter.");
      return;
    }
    remaining -= size;
    files.push({ ref, path, changed, sha: snapshot[ref], text: blob.text });
  }

  const changedPaths = new Set(snapshot.changes.map(change => change.path));
  const interesting = snapshot.changes.filter(change => code.test(change.path) && !excluded.test(change.path));
  for (const change of interesting.slice(0, 6)) {
    if (change.status !== "deleted") await add("head", change.path, true);
    if (change.status !== "added" || change.previousPath) await add("merge_base", change.previousPath ?? change.path, true);
  }
  let scans = 0;
  try {
    if (!snapshot.listPaths) throw new Error("Missing source inventory.");
    const approved = await snapshot.listPaths("base");
    for (const path of approved.filter(name => plan.test(name)).slice(0, 4)) await add("base", path, false);
    const head = await snapshot.listPaths("head");
    const names = interesting.map(change => change.path.split("/").at(-1)!.replace(/\.[^.]+$/, ""));
    for (const path of head) {
      if (!names.length || files.length >= 24 || remaining <= 0 || scans >= 64) break;
      if (changedPaths.has(path) || excluded.test(path) || !code.test(path)) continue;
      scans++;
      const blob = await snapshot.read("head", path);
      if (blob.kind === "text" && blob.text.length <= 12 * 1024
        && names.some(name => blob.text.includes("/" + name + ".") || blob.text.includes("/" + name + "'") || blob.text.includes("/" + name + '"'))) {
        await add("head", path, false);
      }
    }
  } catch {
    limitations.add("The repository inventory was unavailable for related source or approved plans.");
  }
  limitations.add("Model context includes at most six changed paths, four base plans and a bounded search for unchanged callers.");
  return { files, limitations: [...limitations] };
}
