import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export interface MentionRequest {
  installationId: string;
  repoId: string;
  owner: string;
  repo: string;
  number: number;
  commentId: string;
  sender: string;
  senderId: string;
  kind: "review" | "question" | "clarification";
  text: string;
  isPR: boolean;
}

const limit = 256 * 1024;
const login = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const guid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function id(value: unknown): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^[1-9]\d{0,19}$/.test(value)) return value;
  throw new Error("Invalid identifier");
}

export function parseMention(body: string, isPR: boolean): Pick<MentionRequest, "kind" | "text"> | null {
  // Require a direct address at the beginning of the comment. Markdown
  // quotations, code spans, indented/fenced code and examples cannot trigger it.
  const content = body.replace(/^(?:[^\S\r\n]*\r?\n)+/, "");
  const address = /^ {0,3}@(perry|peryy)(?=[\s,:]|$)[,:]?/i.exec(content);
  if (!address) return null;
  const text = content.slice(address[0].length).trim();
  if (!text || text.length > 16_384) return null;
  let kind: MentionRequest["kind"] = "question";
  if (text.toLowerCase() === "review") kind = isPR ? "review" : "clarification";
  return {kind, text};
}

function mention(payload: unknown): MentionRequest | undefined {
  const event = object(payload);
  if (event.action !== "created") return;
  const comment = object(event.comment);
  const user = object(comment.user);
  const sender = object(event.sender);
  if (sender.type !== "User" || user.type !== "User" || typeof comment.body !== "string") return;
  const issue = object(event.issue);
  const isPR = Object.hasOwn(issue, "pull_request");
  const command = parseMention(comment.body, isPR);
  if (!command) return;

  const senderId = id(sender.id);
  if (senderId !== id(user.id) || typeof sender.login !== "string" || !login.test(sender.login)
    || typeof user.login !== "string" || sender.login.toLowerCase() !== user.login.toLowerCase()) return;
  const repository = object(event.repository);
  const owner = object(repository.owner).login;
  const repo = repository.name;
  if (typeof owner !== "string" || !login.test(owner) || typeof repo !== "string"
    || !/^[A-Za-z0-9_.-]{1,100}$/.test(repo) || repo === "." || repo === ".."
    || typeof repository.full_name !== "string" || repository.full_name.toLowerCase() !== (owner + "/" + repo).toLowerCase()) {
    throw new Error("Invalid repository");
  }
  const number = issue.number;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) throw new Error("Invalid issue number");
  if (isPR && !Object.keys(object(issue.pull_request)).length) throw new Error("Invalid pull request");
  return { installationId: id(object(event.installation).id), repoId: id(repository.id), owner, repo, number,
    commentId: id(comment.id), sender: sender.login, senderId, ...command, isPR };
}

export function webhookHandler(secret: string, accept: (id: string, request: MentionRequest) => Promise<void>) {
  if (!secret) throw new Error("Configure a webhook signing secret.");
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    function finish(status: number) {
      res.writeHead(status);
      res.end();
    }
    if (req.url !== "/webhooks/github") return finish(404);
    if (req.method !== "POST") return finish(405);
    const signature = req.headers["x-hub-signature-256"];
    if (typeof signature !== "string" || !/^sha256=[a-f\d]{64}$/i.test(signature)) return finish(401);
    if (Number(req.headers["content-length"]) > limit) return finish(413);
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const data of req.iterator({destroyOnReturn: false})) {
        const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
        size += chunk.length;
        if (size > limit) {
          res.setHeader("Connection", "close");
          return finish(413);
        }
        chunks.push(chunk);
      }
    } catch {
      return finish(400);
    }
    const raw = Buffer.concat(chunks, size);
    const expected = createHmac("sha256", secret).update(raw).digest();
    if (!timingSafeEqual(expected, Buffer.from(signature.slice(7), "hex"))) return finish(401);
    if (req.headers["x-github-event"] !== "issue_comment") return finish(204);
    const delivery = req.headers["x-github-delivery"];
    if (typeof delivery !== "string" || !guid.test(delivery)) return finish(400);
    let request: MentionRequest | undefined;
    try {
      request = mention(JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(raw)));
    } catch {
      return finish(400);
    }
    if (!request) return finish(204);
    try {
      await accept(delivery, request);
    } catch {
      return finish(503);
    }
    finish(202);
  };
}
