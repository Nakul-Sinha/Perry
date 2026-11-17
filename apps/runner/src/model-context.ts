import { posix } from "node:path";
import type { Revision, Snapshot } from "./contracts.ts";
import type { ContextFile } from "./model-review.ts";

const code = /\.(?:[cm]?[jt]sx?|py|go|rs)$/i;
const plan = /^(?:docs\/(?:plans?\/|adr\/)[^/]+|docs\/(?:plan|project idea)|(?:plan|project idea))\.md$/i;
const excluded = /(?:^|\/)(?:\.|node_modules\/|dist\/|build\/|coverage\/|vendor\/|generated\/)|(?:^|[\/._-])(?:credentials?|secrets?|private[-_]?key)(?:[\/._-]|$)/i;
const sensitive = /-----BEGIN [^-\n]*PRIVATE KEY-----|\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{25,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16})\b/;

export function questionPath(path: string): boolean {
  return !excluded.test(path) && (code.test(path) || plan.test(path) || /(?:^|\/)README\.md$/i.test(path));
}
export function containsSensitiveText(text: string): boolean { return sensitive.test(text); }

// These selectors help retrieve evidence; they do not establish semantic links.
function sourceNames(text: string) {
  const clean = text.replace(/\x60(?:\\[\s\S]|[^\x60\\])*\x60|"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g,
    token => token.startsWith("/") || token.startsWith(String.fromCharCode(96)) ? " " : token);
  const syntax = clean.replace(/"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'/g, " ");
  const words = new Set(syntax.match(/[A-Za-z_$][\w$]*/g) ?? []);
  const symbols = [...syntax.matchAll(/\b(?:function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)|\bexport\s+(?:declare\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)]
    .map(match => match[1] ?? match[2]!);
  const imports: string[] = [];
  for (const match of clean.matchAll(/(?:^|[;\n])[ \t]*(import|export)\b/g)) {
    const literal = /^([^;"'\x60]*)(["'])(\.{1,2}\/[^"'\r\n]+)\2/.exec(clean.slice(match.index + match[0].length));
    if (!literal) continue;
    const clause = literal[1]!.trim();
    if ((!clause && match[1] === "import") || (/^[\w${},*\s]+$/.test(clause) && /\bfrom$/.test(clause))) imports.push(literal[3]!);
  }
  return {words, symbols, imports};
}

function localTarget(path: string, specifier: string, inventory: Set<string>): string | undefined {
  if (!specifier.split("/").every(part => /^(?:\.{1,2}|[A-Za-z0-9_$.-]+)$/.test(part))) return;
  const target = posix.join(posix.dirname(path), specifier);
  if (target.startsWith("../") || posix.isAbsolute(target) || excluded.test(target)) return;
  const extensions = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
  const alternatives = [target];
  if (/\.[cm]?jsx?$/.test(target)) {
    const mapped = target.endsWith(".mjs") ? [".mts"] : target.endsWith(".cjs") ? [".cts"]
      : target.endsWith(".jsx") ? [".tsx"] : [".ts", ".tsx"];
    alternatives.push(...mapped.map(ext => target.replace(/\.[cm]?jsx?$/, ext)));
  }
  if (!posix.extname(target)) alternatives.push(...extensions.map(ext => target + ext), ...extensions.map(ext => target + "/index" + ext));
  return alternatives.find(name => inventory.has(name) && code.test(name) && !excluded.test(name));
}

export async function collectContext(snapshot: Snapshot) {
  const files: ContextFile[] = [];
  const paths = new Set<string>();
  const limitations = new Set<string>();
  const textCache = new Map<string, string | null>();
  let remaining = 48 * 1024;
  async function read(ref: Revision, path: string): Promise<string | null> {
    const key = ref + ":" + path;
    if (textCache.has(key)) return textCache.get(key)!;
    let text: string | null = null;
    try {
      const blob = await snapshot.read(ref, path);
      if (blob.kind !== "text") limitations.add("Some source context was unavailable at its pinned revision.");
      else if (Buffer.byteLength(blob.text) > 12 * 1024 || sensitive.test(blob.text)) {
        limitations.add("Some source was withheld by the size or sensitive-content filter.");
      } else text = blob.text;
    } catch { limitations.add("Some source context was unavailable at its pinned revision."); }
    textCache.set(key, text);
    return text;
  }
  async function add(ref: Revision, path: string, changed: boolean) {
    const key = ref + ":" + path;
    if (paths.has(key) || excluded.test(path) || !(code.test(path) || plan.test(path))) return;
    paths.add(key);
    if (files.length >= 24 || remaining <= 0) {
      limitations.add("Some files exceeded the model context budget.");
      return;
    }
    const text = await read(ref, path);
    if (text === null) return;
    const size = Buffer.byteLength(text);
    if (size > remaining) {
      limitations.add("Some files exceeded the model context budget.");
      return;
    }
    remaining -= size;
    files.push({ ref, path, changed, sha: snapshot[ref], text });
  }

  const changedPaths = new Set(snapshot.changes.map(change => change.path));
  const interesting = snapshot.changes.filter(change => code.test(change.path) && !excluded.test(change.path));
  if (interesting.length > 6) limitations.add("Some changed paths exceeded the six-path context limit.");
  for (const change of interesting.slice(0, 6)) {
    if (change.status !== "deleted") await add("head", change.path, true);
    if (change.status !== "added" || change.previousPath) await add("merge_base", change.previousPath ?? change.path, true);
  }
  try {
    if (!snapshot.listPaths) throw new Error("Missing source inventory.");
    const approved = await snapshot.listPaths("base");
    const plans = approved.filter(name => plan.test(name) && !excluded.test(name)).sort();
    if (plans.length > 4) limitations.add("Some approved plans exceeded the four-plan context limit.");
    for (const path of plans.slice(0, 4)) await add("base", path, false);
    const head = new Set((await snapshot.listPaths("head")).filter(path => code.test(path) && !excluded.test(path)));
    const seeds = files.filter(file => file.changed);
    if (seeds.length && remaining > 0 && files.length < 24) {
      const named = [...new Set(seeds.flatMap(file => sourceNames(file.text).symbols))];
      if (named.length > 32) limitations.add("Named-symbol search exceeded its 32-name limit.");
      const symbols = new Set(named.slice(0, 32));
      const selected = new Set(seeds.map(file => file.path));
      const targets = new Set([...head, ...selected]);
      const direct = new Set(seeds.filter(file => file.ref === "head").flatMap(file => sourceNames(file.text).imports
        .map(specifier => localTarget(file.path, specifier, targets)).filter(path => path !== undefined)));
      const test = /(?:^|\/)(?:__tests__|tests?)\/|[.-](?:test|spec)\.[^.]+$/i;
      const priority = (path: string) => (direct.has(path) ? 4 : 0) + (test.test(path) ? 1 : 0);
      const candidates = [...head].filter(path => !changedPaths.has(path))
        .sort((a, b) => priority(b) - priority(a) || a.localeCompare(b));
      if (candidates.length > 64) limitations.add("Related-source search exceeded its 64-file scan limit.");
      let searchBytes = 512 * 1024;
      const related: {path: string; words: Set<string>; targets: Set<string>}[] = [];
      for (const path of candidates.slice(0, 64)) {
        const text = await read("head", path);
        if (text === null) continue;
        const size = Buffer.byteLength(text);
        if (size > searchBytes) {
          limitations.add("Related-source search exceeded its 512 KiB indexing budget.");
          continue;
        }
        searchBytes -= size;
        const names = sourceNames(text);
        related.push({path, words: names.words, targets: new Set(names.imports
          .map(specifier => localTarget(path, specifier, targets)).filter(target => target !== undefined))});
      }
      for (let depth = 0; depth < 3; depth++) {
        const next = related.filter(file => !selected.has(file.path) && (direct.has(file.path)
          || [...file.targets].some(target => selected.has(target))
          || related.some(caller => selected.has(caller.path) && caller.targets.has(file.path))
          || (depth === 0 && [...symbols].some(symbol => file.words.has(symbol)))));
        for (const file of next) selected.add(file.path);
      }
      for (const file of related) {
        if (selected.has(file.path)) await add("head", file.path, false);
      }
    }
  } catch {
    limitations.add("The repository inventory was unavailable for related source or approved plans.");
  }
  limitations.add("Model context is limited to 24 files and 48 KiB, including six changed paths, four base plans and three local relationship hops.");
  limitations.add("Symbol and import selection is heuristic; module aliases, dynamic imports, dynamic dispatch and recent Git history are not resolved.");
  return { files, limitations: [...limitations] };
}
