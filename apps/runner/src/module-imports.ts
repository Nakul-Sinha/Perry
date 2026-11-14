import { posix } from "node:path";
import { parse } from "acorn";
import type { Finding, Revision, Snapshot } from "./contracts.ts";

type Binding = { target: string; name: string; line: number; check: boolean };
type Module = { imports: Binding[]; exports: Set<string> | null; hasUnsupportedImports: boolean };
const excluded = /(?:^|\/)(?:\.git|node_modules|dist|build|generated|coverage|vendor)(?:\/|$)|\.(?:min|generated)\.mjs$/i;
const segment = /^[A-Za-z0-9._~$-]+$/;
const named = /^[a-zA-Z_$][a-zA-Z0-9_$]{0,95}$/;

function localTarget(path: string, specifier: unknown): string | undefined {
  if (typeof specifier !== "string" || !/^\.{1,2}\//.test(specifier) || !specifier.endsWith(".mjs")) return;
  if (!specifier.split("/").every(part => segment.test(part))) return;
  // Only leading parent traversals are in scope for the local path check.
  const parts = specifier.replace(/^(?:\.{1,2}\/)+/, "").split("/");
  if (parts.includes(".") || parts.includes("..")) return;
  const target = posix.join(posix.dirname(path), specifier);
  if (target.startsWith("../") || excluded.test(target)) return;
  return target;
}

function parseModule(path: string, source: string): Module {
  const ast = parse(source, { ecmaVersion: 2024, sourceType: "module", locations: true });
  const imports: Binding[] = [];
  const names = new Set<string>();
  const importedLocals = new Set<string>();
  const forwarded = new Set<string>();
  let simple = true;
  for (const node of ast.body) {
    if (node.type === "ImportDeclaration") {
      for (const spec of node.specifiers) importedLocals.add(spec.local.name);
      const target = localTarget(path, node.source.value);
      if (target && !node.attributes?.length) {
        for (const spec of node.specifiers) {
          if (spec.type === "ImportNamespaceSpecifier") continue;
          const imported = spec.type === "ImportSpecifier" ? spec.imported : undefined;
          const name = imported?.type === "Identifier" ? imported.name : imported ? imported.value : "default";
          if (typeof name === "string" && named.test(name)) {
            imports.push({ target, name, line: spec.loc!.start.line, check: imported?.type === "Identifier" });
          }
        }
      }
    } else if (node.type === "ExportAllDeclaration") {
      simple = false;
    } else if (node.type === "ExportDefaultDeclaration") {
      names.add("default");
    } else if (node.type === "ExportNamedDeclaration") {
      if (node.source) simple = false;
      for (const spec of node.specifiers) {
        if (spec.exported.type === "Identifier") names.add(spec.exported.name);
        else simple = false;
        if (spec.local.type === "Identifier") forwarded.add(spec.local.name);
      }
      const decl = node.declaration;
      if (decl?.type === "VariableDeclaration") {
        for (const variable of decl.declarations) {
          if (variable.id.type === "Identifier") names.add(variable.id.name);
          else simple = false;
        }
      } else if (decl?.type === "FunctionDeclaration" || decl?.type === "ClassDeclaration") {
        names.add(decl.id.name);
      } else if (decl) {
        simple = false;
      }
    }
  }
  // An unsupported spelling of a previous import could be equivalent to a
  // current literal specifier after URL resolution. Keep its origin unknown.
  const hasUnsupportedImports = ast.body.some(node => node.type === "ExportNamedDeclaration" && !!node.source || node.type === "ImportDeclaration"
    && node.specifiers.some(spec => spec.type !== "ImportNamespaceSpecifier")
    && (!localTarget(path, node.source.value) || node.attributes?.length));
  for (const local of forwarded) {
    if (importedLocals.has(local)) simple = false;
  }
  return { imports, exports: simple ? names : null, hasUnsupportedImports };
}

// Opportunistic linking check for changed consumers. A missing or unsupported
// source cannot prove that an imported binding is absent.
export async function inspectImports(snapshot: Snapshot): Promise<{ findings: Finding[]; limitations: string[] }> {
  const findings = new Map<string, Finding>();
  const limits = new Set<string>();
  const cache = new Map<string, Module | "missing" | "unknown">();
  let bytesLeft = 512 * 1024;
  let importsLeft = 128;
  const budget = "The import check reached its limit on source, modules or named bindings.";
  const unavailable = "Some import or export evidence was unavailable or outside the supported source syntax.";

  async function load(rev: Revision, path: string) {
    const key = rev + ":" + path;
    const cached = cache.get(key);
    if (cached) return cached;
    if (cache.size >= 64) {
      limits.add(budget);
      return "unknown";
    }
    const blob = await snapshot.read(rev, path);
    let value: Module | "missing" | "unknown" = "unknown";
    if (blob.kind === "missing") value = "missing";
    if (blob.kind === "text") {
      const size = Buffer.byteLength(blob.text);
      if (size <= 64 * 1024 && size <= bytesLeft) {
        bytesLeft -= size;
        try {
          if (!/\r(?!\n)|[\u2028\u2029]/u.test(blob.text)) value = parseModule(path, blob.text);
        } catch {
          // Syntax checking has its own pass and separate findings.
        }
      } else limits.add(budget);
    }
    if (value === "unknown") limits.add(unavailable);
    cache.set(key, value);
    return value;
  }

  const hasDeletedPaths = snapshot.changes.some(change => change.status === "deleted");
  const relevant = snapshot.changes.filter(change => change.path.endsWith(".mjs") && ["added", "modified"].includes(change.status)
    && !excluded.test(change.path) && change.path.split("/").every(part => part !== "." && part !== ".." && segment.test(part)));
  if (relevant.length) limits.add("Import checking follows simple named relative .mjs bindings from changed consumers. Other module resolution and execution remain unassessed.");
  if (relevant.length > 24) limits.add(budget);
  for (const { path, status } of relevant.slice(0, 24)) {
    const current = await load("head", path);
    if (typeof current === "string" || !current.imports.some(binding => binding.check)) continue;
    if (status === "added" && hasDeletedPaths) {
      limits.add("An added consumer may have been renamed from a deleted path. Its previous imports need review.");
      continue;
    }
    const previous = await load("merge_base", path);
    if (status === "added" ? previous !== "missing" : typeof previous === "string") {
      limits.add(unavailable);
      continue;
    }
    for (const { target, name, line, check } of current.imports) {
      if (!check) continue;
      if (importsLeft-- <= 0) { limits.add(budget); break; }
      const provider = await load("head", target);
      if (typeof provider === "string" || !provider.exports) { limits.add(unavailable); continue; }
      if (provider.exports.has(name)) continue;
      const existed = typeof previous === "object" && previous.imports.some(binding => binding.target === target && binding.name === name);
      if (!existed && typeof previous === "object" && previous.hasUnsupportedImports) {
        limits.add(unavailable);
        continue;
      }
      if (existed) {
        const priorProvider = await load("merge_base", target);
        if (typeof priorProvider === "string" || !priorProvider.exports) { limits.add(unavailable); continue; }
        if (!priorProvider.exports.has(name)) continue;
      }
      const id = "esm-export:" + target + ":" + name;
      if (!findings.has(id)) findings.set(id, {
        id, title: "Missing named export: " + name, severity: "medium",
        trigger: "Load " + path + " directly with Node ESM.",
        impact: target + " has no named export " + name + ", so the consumer fails during module linking.",
        fix: "Use the name that " + target + " exports or add the intended named export there.",
        evidence: { sha: snapshot.head, path, line },
      });
    }
  }
  return { findings: [...findings.values()], limitations: [...limits] };
}
