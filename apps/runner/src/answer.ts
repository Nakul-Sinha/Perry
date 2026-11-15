import type { Snapshot } from "./contracts.ts";
import { containsSensitiveText, questionPath } from "./model-context.ts";
import { anthropicBackend } from "./model-review.ts";

const stop = new Set("what where when why how who does do did is are was were has have it its in to at as of be by for on the a an and or with that this which file code about from tell me show would could can please function repo repository".split(" "));
type Excerpt = { path: string; line: number; endLine: number; text: string; score: number };

// A value can be sensitive without a provider-specific key prefix. Withhold
// the whole excerpt or question when it contains an explicit literal value.
function sensitive(text: string) {
  return containsSensitiveText(text)
    || /\b(?:password|passwd|secret|(?:api|access|auth|private)[-_]?(?:key|token)|client[-_]?secret)["']?\s*[:=]\s*["'][^"'\r\n]{1,}["']/i.test(text)
    || /\b(?:authorization\s*:\s*(?:basic|bearer)\s+[^\s"']+|https?:\/\/[^\s/:@]+:[^\s/@]+@)/i.test(text);
}

// Source and provider text are displayed literally, including Markdown, mentions and links.
function literal(text: string) {
  const line = text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").trim();
  const width = Math.max(0, ...Array.from(line.matchAll(/`+/g), item => item[0].length)) + 1;
  const fence = "`".repeat(width);
  return fence + " " + line + " " + fence;
}

export async function answerQuestion(snapshot: Snapshot, question: string, model?: string, connect = anthropicBackend) {
  const heading = "## Perry answer\n\nReviewed commit " + literal(snapshot.head) + ".";
  const unable = heading + "\n\nThe available source did not establish an answer. Try a symbol, filename or more specific question.";
  if (!question.trim() || question.length > 1600 || sensitive(question)) return unable;
  const terms = [...new Set(question.toLowerCase().match(/[a-z0-9_$][a-z0-9_$.-]*/g) ?? [])]
    .map(term => term.replace(/[.-]+$/, "")).filter(term => term.length > 1 && !stop.has(term)).slice(0, 12);
  if (!terms.length || !snapshot.listPaths) return unable;
  let paths;
  try {
    paths = (await snapshot.listPaths("head")).filter(path => questionPath(path) && !containsSensitiveText(path));
  } catch {
    return unable;
  }
  const changed = new Set(snapshot.changes.map(change => change.path));
  const priority = (path: string) => (changed.has(path) ? 2 : 0) + (terms.some(term => path.toLowerCase().includes(term)) ? 4 : 0);
  paths.sort((a, b) => priority(b) - priority(a) || a.localeCompare(b));
  const hits: Excerpt[] = [];
  let budget = 384 * 1024;
  for (const path of paths.slice(0, 80)) {
    if (budget <= 0) break;
    const blob = await snapshot.read("head", path);
    if (blob.kind !== "text") continue;
    const size = Buffer.byteLength(blob.text);
    budget -= size;
    if (budget < 0) break;
    if (size > 24 * 1024 || sensitive(blob.text)) continue;
    let best: Excerpt | undefined;
    const lines = blob.text.split(/\r?\n/);
    const namedFile = terms.includes(path.split("/").at(-1)!.toLowerCase());
    for (const [i, text] of lines.entries()) {
      if (!text.trim() || text.length > 280) continue;
      const words = text.toLowerCase().match(/[a-z0-9_$]+/g) ?? [];
      const score = terms.filter(term => term.includes(".") || term.includes("-")
        ? text.toLowerCase().includes(term) : words.some(word => word === term)).length;
      if ((!score && !namedFile) || (best && score <= best.score)) continue;
      // Include a short continuation so a declaration can cite its return or guard.
      const next = lines[i + 1]?.trim();
      const continuation = !!next && next.length <= 240 && !/^[}\]);]+$/.test(next);
      best = {
        path, line: i + 1, endLine: i + (continuation ? 2 : 1),
        text: continuation ? text.trim() + "\n" + next : text.trim(), score,
      };
    }
    if (best) hits.push(best);
  }
  const excerpts = hits.sort((a, b) => b.score - a.score).slice(0, 5);
  if (!excerpts.length) return unable;
  let message = "Matching committed source";
  let selected = excerpts;
  if (model) {
    try {
      const raw = await connect(model)("question", JSON.stringify({question, excerpts}));
      if (Buffer.byteLength(raw) > 8000) return unable;
      const reply = JSON.parse(raw);
      if (typeof reply?.answer !== "string" || !reply.answer.trim() || reply.answer.length > 1000
        || sensitive(reply.answer) || !Array.isArray(reply.citations) || !reply.citations.length
        || !reply.citations.every((n: unknown) => typeof n === "number" && Number.isInteger(n) && !!excerpts[n])) return unable;
      selected = [...new Set<number>(reply.citations)].map(i => excerpts[i]!);
      message = literal(reply.answer);
    } catch { message = "The model answer was unavailable. Matching committed source"; }
  }
  return heading + "\n\n" + message + "\n\n" + selected.map(x => {
    const range = x.endLine === x.line ? String(x.line) : x.line + "-" + x.endLine;
    return "- " + literal(x.path + ":" + range) + " " + literal(x.text);
  }).join("\n");
}
