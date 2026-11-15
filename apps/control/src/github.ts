import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { AsyncLocalStorage } from "node:async_hooks";
import { parseMention, type MentionRequest } from "./intake.ts";

export type CommentSlot = "summary" | "findings" | "answer";
export class UncertainComment extends Error {}

interface GitHubConfig { appId: string; privateKey: string; botId: string }
interface Comment {
  id: number;
  body?: string;
  user: { id: number; type: string } | null;
  issue_url: string;
}

function numericId(value: string) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1 || String(id) !== value) throw new Error("Unsupported GitHub identifier.");
  return id;
}

function status(error: unknown) {
  return error && typeof error === "object" && "status" in error ? error.status : undefined;
}

function threadURL(r: MentionRequest) {
  return `https://api.github.com/repos/${r.owner}/${r.repo}/issues/${r.number}`.toLowerCase();
}

export class GitHubGateway {
  private readonly auth: ReturnType<typeof createAppAuth>;
  private readonly options: ConstructorParameters<typeof Octokit>[0];
  private readonly botId: number;
  // The auth SDK accepts a transport at construction and obtains installation
  // tokens asynchronously. Propagate each worker's lease signal into that call.
  private readonly authSignal = new AsyncLocalStorage<AbortSignal | undefined>();

  constructor(config: GitHubConfig, options: { fetch?: typeof fetch } = {}) {
    this.botId = numericId(config.botId);
    const transport = options.fetch ?? globalThis.fetch;
    this.options = {
      baseUrl: "https://api.github.com",
      request: {
        fetch: (url: string, init: RequestInit) => {
          if (new URL(url).origin !== "https://api.github.com") throw new Error("Unexpected GitHub API destination.");
          const deadline = AbortSignal.timeout(10_000);
          const signals = [deadline];
          if (init.signal) signals.push(init.signal);
          const lease = this.authSignal.getStore();
          if (lease) signals.push(lease);
          const signal = AbortSignal.any(signals);
          signal.throwIfAborted();
          return transport(url, { ...init, redirect: "error", signal });
        },
      },
      log: { debug() {}, info() {}, warn() {}, error() {} },
    };
    const api = new Octokit(this.options);
    this.auth = createAppAuth({ appId: numericId(config.appId), privateKey: config.privateKey, request: api.request });
  }

  private async client(r: MentionRequest, signal?: AbortSignal) {
    // Mint only for this repository. GitHub rejects an installation which
    // cannot access the ID, even if anonymous users can read the repository.
    signal?.throwIfAborted();
    const { token } = await this.authSignal.run(signal, () => this.auth({
      type: "installation", installationId: numericId(r.installationId), repositoryIds: [numericId(r.repoId)],
    }));
    signal?.throwIfAborted();
    return new Octokit({ ...this.options, auth: token });
  }

  async sourceToken(r: MentionRequest, signal?: AbortSignal): Promise<string> {
    try {
      signal?.throwIfAborted();
      const scoped = await this.authSignal.run(signal, () => this.auth({
        type: "installation", installationId: numericId(r.installationId), repositoryIds: [numericId(r.repoId)],
        permissions: { contents: "read" }, refresh: true,
      }));
      signal?.throwIfAborted();
      if (scoped.permissions?.contents !== "read" || Object.entries(scoped.permissions).some(
        ([key, value]) => !["contents", "metadata"].includes(key) || value !== "read",
      ) || scoped.repositoryIds?.length !== 1 || String(scoped.repositoryIds[0]) !== r.repoId) {
        throw new Error();
      }
      return scoped.token;
    } catch {
      throw new Error("Repository-scoped source access is unavailable.");
    }
  }

  async authorize(r: MentionRequest, signal?: AbortSignal): Promise<boolean> {
    try {
      signal?.throwIfAborted();
      const api = await this.client(r, signal);
      const repo = { owner: r.owner, repo: r.repo, request: signal ? { signal } : {} };
      // A public repository can be readable after installation access changes.
      // The scoped installation listing checks the current grant itself.
      const { data: grants } = await api.rest.apps.listReposAccessibleToInstallation({ per_page: 2, request: repo.request });
      if (grants.total_count !== 1 || grants.repositories.length !== 1 || String(grants.repositories[0]?.id) !== r.repoId) return false;
      const { data: repository } = await api.rest.repos.get(repo);
      if (String(repository.id) !== r.repoId || repository.full_name.toLowerCase() !== (r.owner + "/" + r.repo).toLowerCase()) return false;
      const { data: perm } = await api.rest.repos.getCollaboratorPermissionLevel({ ...repo, username: r.sender });
      if (!["write", "maintain", "admin"].includes(perm.permission) || String(perm.user?.id) !== r.senderId) return false;
      const { data: comment } = await api.rest.issues.getComment({ ...repo, comment_id: numericId(r.commentId) });
      if (comment.issue_url.toLowerCase() !== threadURL(r) || String(comment.id) !== r.commentId
        || comment.user?.type !== "User" || String(comment.user.id) !== r.senderId) return false;
      const intent = parseMention(comment.body ?? "", r.isPR);
      return intent?.kind === r.kind && intent.text === r.text;
    } catch (error) {
      if (status(error) === 404 || status(error) === 410) return false;
      throw new Error("GitHub requester authorization is unavailable.");
    }
  }

  async refs(r: MentionRequest, signal?: AbortSignal): Promise<{ base: string; head: string } | null> {
    try {
      signal?.throwIfAborted();
      const api = await this.client(r, signal);
      const repo = { owner: r.owner, repo: r.repo, request: signal ? { signal } : {} };
      let head, base;
      if (r.isPR) {
        const { data: pr } = await api.rest.pulls.get({ ...repo, pull_number: r.number });
        if (pr.state !== "open" || pr.number !== r.number || String(pr.base.repo.id) !== r.repoId) return null;
        base = pr.base.sha;
        head = pr.head.sha;
      } else {
        const { data: repository } = await api.rest.repos.get(repo);
        if (String(repository.id) !== r.repoId) return null;
        const { data: branch } = await api.rest.repos.getBranch({ ...repo, branch: repository.default_branch });
        base = head = branch.commit.sha;
      }
      return [base, head].every(sha => /^[a-f0-9]{40}$/.test(sha)) ? { base, head } : null;
    } catch (error) {
      if (status(error) === 404 || status(error) === 410) return null;
      throw new Error("GitHub source revisions are unavailable.");
    }
  }

  async writeSlot(r: MentionRequest, slot: CommentSlot, body: string, knownId?: string, canCreate = true,
    signal?: AbortSignal, reserve?: () => Promise<void>): Promise<string> {
    if ((r.kind === "review") !== (slot !== "answer") || (r.kind === "review" && !r.isPR)) {
      throw new Error("Invalid GitHub comment destination.");
    }
    const slotName = slot === "answer" ? "answer-" + r.commentId : slot;
    const marker = `<!-- perry:${r.installationId}:${r.repoId}:${r.number}:${slotName} -->`;
    const rendered = body.trimEnd() + "\n\n" + marker;
    if (!body.trim() || rendered.length > 60_000) throw new Error("Comment exceeds the supported publication budget or is empty.");
    if (!(await this.authorize(r, signal))) throw new Error("GitHub comment access was revoked.");
    const owned = (comment: Comment) => comment.user?.id === this.botId && comment.user.type === "Bot"
      && comment.issue_url.toLowerCase() === threadURL(r) && comment.body?.split("\n").at(-1) === marker;
    try {
      const api = await this.client(r, signal);
      const repo = { owner: r.owner, repo: r.repo, request: signal ? { signal } : {} };
      let target: Comment | undefined;
      if (knownId) {
        const { data } = await api.rest.issues.getComment({ ...repo, comment_id: numericId(knownId) });
        if (!owned(data) || String(data.id) !== knownId) throw new UncertainComment("Stored GitHub comment ownership changed.");
        target = data;
      } else {
        const pages = api.paginate.iterator(api.rest.issues.listComments, { ...repo, issue_number: r.number, per_page: 100 });
        for await (const page of pages) {
          for (const comment of page.data.filter(owned)) {
            if (target) throw new UncertainComment("Multiple owned GitHub comments match the publication slot.");
            target = comment;
          }
        }
      }
      if (target) {
        await reserve?.();
        signal?.throwIfAborted();
        if (target.body !== rendered) await api.rest.issues.updateComment({ ...repo, comment_id: target.id, body: rendered });
        return String(target.id);
      }
      if (!canCreate) throw new UncertainComment("The previous GitHub comment write has no visible receipt.");
      // A failed lookup has no external effect. Record intent only once the
      // lookup succeeds and immediately before dispatching the first write.
      await reserve?.();
      signal?.throwIfAborted();
      const { data } = await api.rest.issues.createComment({ ...repo, issue_number: r.number, body: rendered });
      if (!owned(data)) throw new UncertainComment("GitHub returned an unverified comment receipt.");
      return String(data.id);
    } catch (error) {
      if (error instanceof UncertainComment) throw error;
      throw new Error("GitHub comment publication could not be confirmed.");
    }
  }
}
