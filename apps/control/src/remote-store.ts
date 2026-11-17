import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { MentionRequest } from "./intake.ts";
import type { RunnerScope } from "./pairing-store.ts";
import type { Bodies, Refs } from "./worker.ts";

export interface RemoteClaim {
  jobId: string;
  leaseToken: string;
  request: MentionRequest;
  refs: Refs;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const leaseFormat = /^[A-Za-z0-9_-]{43}$/;
const digest = (token: string) => createHash("sha256").update(token).digest("hex");
const leaseDuration = "interval '90 seconds'";

// A shared row lock orders runner mutations against operator revocation.
const activeRunner = `
  WITH active_runner AS MATERIALIZED (
    SELECT id FROM perry_runners
    WHERE installation_id = $1 AND repo_id = $2 AND id = $3 AND revoked_at IS NULL
    FOR SHARE
  )`;
const ownedLease = activeRunner + `, owned AS MATERIALIZED (
    SELECT j.id, j.lease_until, j.expires_at, j.request->>'kind' AS kind, j.result
    FROM active_runner r JOIN perry_remote_jobs j ON j.runner_id = r.id
    WHERE j.installation_id = $1 AND j.repo_id = $2 AND j.id = $4 AND j.lease_digest = $5 AND NOT j.cancelled
    FOR UPDATE OF j
  )`;

function resultKind(bodies: unknown) {
  if (bodies === null || typeof bodies !== "object" || Array.isArray(bodies)) return null;
  const fields = Object.keys(bodies);
  if (!Object.values(bodies).every(value => typeof value === "string" && value.trim().length > 0
    && Buffer.byteLength(value) <= 58_000 && !/[\u0000\uD800-\uDFFF]/u.test(value))) return null;
  const data = bodies as Record<string, string>;
  if (fields.length === 1 && fields[0] === "answer" && data.answer?.startsWith("## Perry answer\n\n")) return "question";
  if (fields.length !== 2 || !fields.includes("summary") || !fields.includes("findings")
    || !data.findings?.startsWith("## Bugs and suggested fixes\n\n") || !data.summary) return null;
  const [heading, gap, line, ...details] = data.summary.split("\n");
  const status = /^\*\*(HOLD|DO NOT MERGE) \| ([0-9]|10)\/10 merge readiness( \(provisional\))?\*\*$/;
  if (heading === "## Perry review" && gap === "" && status.test(line ?? "")
    && !details.some(value => /^\s*\*\*(?:HOLD|(?:DO NOT )?MERGE)\s*\|/i.test(value))) return "review";
  return null;
}

export class RemoteStore {
  private readonly pool: Pool;
  constructor(pool: Pool) { this.pool = pool; }

  async init(): Promise<void> {
    await this.pool.query(`
      SELECT pg_advisory_xact_lock(185305, 0);
      CREATE TABLE IF NOT EXISTS perry_remote_jobs (
        id uuid PRIMARY KEY,
        installation_id text NOT NULL,
        repo_id text NOT NULL,
        comment_id text NOT NULL,
        base_sha text NOT NULL,
        head_sha text NOT NULL,
        same_repository boolean,
        request jsonb NOT NULL,
        queued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        expires_at timestamptz NOT NULL DEFAULT (clock_timestamp() + interval '20 minutes'),
        runner_id uuid,
        lease_digest text,
        lease_until timestamptz,
        result jsonb,
        cancelled boolean NOT NULL DEFAULT false,
        UNIQUE (installation_id, repo_id, comment_id, base_sha, head_sha)
      );
      CREATE INDEX IF NOT EXISTS perry_remote_pending
        ON perry_remote_jobs (installation_id, repo_id, queued_at, id) WHERE NOT cancelled AND result IS NULL;
    `);
  }

  async enqueue(request: MentionRequest, refs: Refs): Promise<string> {
    if (request.kind === "clarification" || ![refs.base, refs.head].every(sha => /^[0-9a-f]{40}$/.test(sha))) {
      throw new Error("A remote assessment requires a review or question pinned to source commits.");
    }
    const row = await this.pool.query<{id: string}>(`
      INSERT INTO perry_remote_jobs AS j
        (id, installation_id, repo_id, comment_id, base_sha, head_sha, same_repository, request)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (installation_id, repo_id, comment_id, base_sha, head_sha) DO UPDATE SET id = j.id
      RETURNING id
    `, [randomUUID(), request.installationId, request.repoId, request.commentId, refs.base, refs.head,
      refs.sameRepository ?? null, JSON.stringify(request)]);
    return row.rows[0]!.id;
  }

  async claim(scope: RunnerScope, runnerId: string): Promise<RemoteClaim | null> {
    if (!uuid.test(runnerId)) return null;
    const token = randomBytes(32).toString("base64url");
    const row = await this.pool.query<{id: string; request: MentionRequest; base_sha: string; head_sha: string; same_repository: boolean | null}>(activeRunner + `,
      next_job AS (
        SELECT j.id FROM active_runner CROSS JOIN perry_remote_jobs j
        WHERE j.installation_id = $1 AND j.repo_id = $2 AND NOT j.cancelled AND j.result IS NULL AND j.expires_at > clock_timestamp()
          AND (j.lease_until IS NULL OR j.lease_until <= clock_timestamp())
        ORDER BY j.queued_at, j.id LIMIT 1 FOR UPDATE OF j SKIP LOCKED
      )
      UPDATE perry_remote_jobs j SET runner_id = $3, lease_digest = $4, lease_until = least(j.expires_at, clock_timestamp() + ${leaseDuration})
      FROM next_job WHERE j.id = next_job.id
      RETURNING j.id, j.request, j.base_sha, j.head_sha, j.same_repository
    `, [scope.installationId, scope.repoId, runnerId, digest(token)]);
    const job = row.rows[0];
    if (!job) return null;
    const refs: Refs = {base: job.base_sha, head: job.head_sha};
    if (job.same_repository !== null) refs.sameRepository = job.same_repository;
    return {jobId: job.id, leaseToken: token, request: job.request, refs};
  }

  async heartbeat(scope: RunnerScope, runnerId: string, jobId: string, leaseToken: string): Promise<boolean> {
    if (!uuid.test(runnerId) || !uuid.test(jobId) || !leaseFormat.test(leaseToken)) return false;
    // Check the database clock after acquiring the job lock, including time spent waiting.
    const updated = await this.pool.query(ownedLease + `
      UPDATE perry_remote_jobs j SET lease_until = least(owned.expires_at, clock_timestamp() + ${leaseDuration})
      FROM owned WHERE j.id = owned.id AND owned.result IS NULL AND least(owned.lease_until, owned.expires_at) > clock_timestamp()
    `, [scope.installationId, scope.repoId, runnerId, jobId, digest(leaseToken)]);
    return updated.rowCount === 1;
  }

  async complete(scope: RunnerScope, runnerId: string, jobId: string, leaseToken: string, bodies: Bodies): Promise<boolean> {
    const kind = resultKind(bodies);
    if (!kind || !uuid.test(runnerId) || !uuid.test(jobId) || !leaseFormat.test(leaseToken)) return false;
    // Keep the digest as a receipt so the winning runner can retry a lost acknowledgement.
    const saved = await this.pool.query(ownedLease + `, saved AS (
      UPDATE perry_remote_jobs j SET result = $7::jsonb, lease_until = NULL
      FROM owned WHERE j.id = owned.id AND owned.result IS NULL AND least(owned.lease_until, owned.expires_at) > clock_timestamp() AND owned.kind = $6
      RETURNING j.id
    )
      SELECT id FROM saved UNION ALL SELECT id FROM owned WHERE result = $7::jsonb
    `, [scope.installationId, scope.repoId, runnerId, jobId, digest(leaseToken), kind, JSON.stringify(bodies)]);
    return saved.rowCount === 1;
  }

  async result(jobId: string): Promise<Bodies | null> {
    const row = await this.pool.query<{result: Bodies | null; cancelled: boolean}>(`
      WITH job AS MATERIALIZED (
        SELECT id, result, cancelled, expires_at FROM perry_remote_jobs WHERE id = $1 FOR UPDATE
      ), expired AS (
        UPDATE perry_remote_jobs j SET cancelled = true, runner_id = NULL, lease_digest = NULL, lease_until = NULL
        FROM job WHERE j.id = job.id AND job.result IS NULL AND NOT job.cancelled AND job.expires_at <= clock_timestamp()
        RETURNING j.id
      )
      SELECT result, (cancelled OR EXISTS (SELECT 1 FROM expired)) AS cancelled FROM job
    `, [jobId]);
    if (row.rows[0]?.cancelled) throw new Error("The remote assessment was cancelled.");
    return row.rows[0]?.result ?? null;
  }

  async cancel(jobId: string): Promise<void> {
    await this.pool.query(`
      UPDATE perry_remote_jobs SET cancelled = true, runner_id = NULL, lease_digest = NULL, lease_until = NULL
      WHERE id = $1 AND result IS NULL AND NOT cancelled
    `, [jobId]);
  }
}
