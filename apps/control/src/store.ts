import type { Pool, PoolClient } from "pg";
import type { MentionRequest } from "./intake.ts";
import type { Observation, Refs, ReviewWatch } from "./worker.ts";

type Slot = "summary" | "findings" | "answer";
export interface Job {
  readonly signal: AbortSignal;
  loadResult<T>(): Promise<T | null>;
  saveResult<T>(result: T): Promise<void>;
  getSlot(slot: Slot): Promise<string | null>;
  markCreating(slot: Slot): Promise<void>;
  saveSlot(slot: Slot, commentId: string): Promise<void>;
}

const maxAttempts = 5;
const ddl = `
  CREATE TABLE IF NOT EXISTS perry_deliveries (id text PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS perry_mentions (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    scope text NOT NULL,
    comment_id text NOT NULL,
    request jsonb NOT NULL,
    result jsonb,
    state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'done', 'failed')),
    attempts integer NOT NULL DEFAULT 0,
    available_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (scope, comment_id)
  );
  CREATE INDEX IF NOT EXISTS perry_queue_heads ON perry_mentions (scope, id) WHERE state <> 'done';
  CREATE TABLE IF NOT EXISTS perry_slots (
    scope text NOT NULL,
    name text NOT NULL,
    comment_id text NOT NULL,
    PRIMARY KEY (scope, name)
  );
  CREATE TABLE IF NOT EXISTS perry_review_watches (
    scope text PRIMARY KEY,
    mention_id bigint NOT NULL REFERENCES perry_mentions(id),
    reviewed jsonb NOT NULL,
    observed jsonb,
    due_at timestamptz,
    failures integer NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS perry_watch_due ON perry_review_watches (due_at) WHERE due_at IS NOT NULL;
  INSERT INTO perry_review_watches (scope, mention_id, reviewed, due_at)
  SELECT DISTINCT ON (m.scope) m.scope, m.id, m.result->'refs', now() + interval '5 minutes'
  FROM perry_mentions m
  WHERE m.state = 'done' AND m.request->>'kind' = 'review' AND m.result->'bodies' ? 'summary'
    AND m.result->'refs'->>'base' ~ '^[0-9a-f]{40}$' AND m.result->'refs'->>'head' ~ '^[0-9a-f]{40}$'
    AND NOT EXISTS (SELECT 1 FROM perry_review_watches w WHERE w.scope = m.scope)
  ORDER BY m.scope, m.id DESC ON CONFLICT DO NOTHING;
`;

function createJob(client: PoolClient, id: string, scope: string, request: MentionRequest, signal: AbortSignal): Job {
  const slotName = (slot: Slot) => {
    signal.throwIfAborted();
    if (request.kind === "review" && (slot === "summary" || slot === "findings")) return slot;
    if (request.kind !== "review" && slot === "answer") return "answer:" + request.commentId;
    throw new Error("The request cannot publish to this comment slot.");
  };
  return {
    signal,
    async loadResult<T>() {
      signal.throwIfAborted();
      const result = await client.query<{result: T | null}>("SELECT result FROM perry_mentions WHERE id = $1", [id]);
      return result.rows[0]!.result;
    },
    async saveResult(value) {
      signal.throwIfAborted();
      const json = JSON.stringify(value);
      if (!json || json === "null" || Buffer.byteLength(json) > 1024 * 1024) throw new Error("Invalid stored result.");
      const saved = await client.query(`
        UPDATE perry_mentions SET result = $2::jsonb
        WHERE id = $1 AND (result IS NULL OR result = $2::jsonb)
      `, [id, json]);
      if (saved.rowCount !== 1) throw new Error("The stored result is immutable.");
    },
    async getSlot(slot) {
      const row = await client.query<{comment_id: string}>(
        "SELECT comment_id FROM perry_slots WHERE scope = $1 AND name = $2", [scope, slotName(slot)],
      );
      return row.rows[0]?.comment_id ?? null;
    },
    async markCreating(slot) {
      const created = await client.query(`
        INSERT INTO perry_slots (scope, name, comment_id) VALUES ($1, $2, 'creating')
        ON CONFLICT DO NOTHING
      `, [scope, slotName(slot)]);
      if (created.rowCount !== 1) throw new Error("The comment slot already exists. Reconcile it before publishing.");
    },
    async saveSlot(slot, commentId) {
      if (!/^[1-9][0-9]*$/.test(commentId)) throw new Error("Expected a GitHub comment ID.");
      const saved = await client.query(`
        UPDATE perry_slots SET comment_id = $3
        WHERE scope = $1 AND name = $2 AND comment_id IN ('creating', $3)
      `, [scope, slotName(slot), commentId]);
      if (saved.rowCount !== 1) throw new Error("Cannot replace the comment slot owner.");
    },
  };
}

export class Store {
  private readonly pool: Pool;
  constructor(pool: Pool) { this.pool = pool; }

  async init(): Promise<void> {
    // The implicit transaction includes the startup lock and all DDL.
    await this.pool.query("SELECT pg_advisory_xact_lock(185299, 0);" + ddl);
  }

  async accept(deliveryId: string, request: MentionRequest): Promise<void> {
    const scope = JSON.stringify([request.installationId, request.repoId, request.number]);
    // Serialize admission for one thread so visible jobs have stable commit order.
    // Admission and processing use distinct lock namespaces.
    await this.pool.query(`
      WITH admission AS MATERIALIZED (SELECT pg_advisory_xact_lock(185300, hashtext($2))),
           received AS (
             INSERT INTO perry_deliveries (id) SELECT $1 FROM admission
             ON CONFLICT DO NOTHING RETURNING id
           )
      INSERT INTO perry_mentions (scope, comment_id, request)
      SELECT $2, $3, $4::jsonb FROM received
      ON CONFLICT (scope, comment_id) DO NOTHING
    `, [deliveryId, scope, request.commentId, JSON.stringify(request)]);
  }

  async retryFailed(installationId: string, repoId: string, number: number, commentId: string): Promise<boolean> {
    const row = await this.pool.query(`
      UPDATE perry_mentions SET state = 'pending', available_at = now(), attempts = 0
      WHERE scope = $1 AND comment_id = $2 AND state = 'failed'
    `, [JSON.stringify([installationId, repoId, number]), commentId]);
    return row.rowCount === 1;
  }

  private async session<T>(run: (client: PoolClient, signal: AbortSignal) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const lifetime = new AbortController();
    const lost = () => lifetime.abort(new Error("The PostgreSQL publisher session closed."));
    client.on("error", lost);
    client.on("end", lost);
    let destroy = false;
    try {
      return await run(client, lifetime.signal);
    } catch (error) {
      destroy = true;
      throw error;
    } finally {
      lifetime.abort();
      client.removeListener("error", lost);
      client.removeListener("end", lost);
      client.release(destroy);
    }
  }

  async workOne(process: (request: MentionRequest, job: Job) => Promise<void | Refs>, repository?: { installationId: string; repoId: string }): Promise<boolean> {
    return this.session(async (client, signal) => {
      let after = "0";
      while (!signal.aborted) {
        const candidates = await client.query<{id: string; scope: string}>(`
          SELECT j.id, j.scope FROM perry_mentions j
          WHERE j.id > $1 AND j.state = 'pending' AND j.available_at <= now()
            AND ($2::text IS NULL OR (j.request->>'installationId' = $2 AND j.request->>'repoId' = $3))
            AND NOT EXISTS (SELECT 1 FROM perry_mentions p WHERE p.scope = j.scope AND p.id < j.id AND p.state <> 'done')
            AND (j.request->>'kind' <> 'review' OR NOT EXISTS (
              SELECT 1 FROM perry_review_watches w WHERE w.scope = j.scope AND w.observed IS NOT NULL
            ))
          ORDER BY j.id LIMIT 16
        `, [after, repository?.installationId ?? null, repository?.repoId ?? null]);
        if (!candidates.rowCount) return false;
        for (const { id, scope } of candidates.rows) {
          after = id;
          const lock = await client.query<{locked:boolean}>(
            "SELECT pg_try_advisory_lock(185301, hashtext($1)) AS locked", [scope],
          );
          if (!lock.rows[0]!.locked) continue;
          try {
            // Recheck state inside the session lock. The candidate could have
            // completed between discovery and lock acquisition.
            const claimed = await client.query<{request:MentionRequest; attempts:number}>(`
              UPDATE perry_mentions SET attempts = attempts + 1
              WHERE id = $1 AND state = 'pending' AND available_at <= now()
                AND (request->>'kind' <> 'review' OR NOT EXISTS (
                  SELECT 1 FROM perry_review_watches w WHERE w.scope = perry_mentions.scope AND w.observed IS NOT NULL
                ))
              RETURNING request, attempts
            `, [id]);
            const row = claimed.rows[0];
            if (!row) continue;
            if (row.attempts <= maxAttempts) {
              try {
                const refs = await process(row.request, createJob(client, id, scope, row.request, signal));
                signal.throwIfAborted();
                if (refs && row.request.kind === "review") {
                  await client.query(`
                    WITH finished AS (UPDATE perry_mentions SET state = 'done' WHERE id = $1 RETURNING id, scope)
                    INSERT INTO perry_review_watches(scope, mention_id, reviewed, due_at)
                    SELECT scope, id, $2::jsonb, now() + interval '5 minutes' FROM finished
                    ON CONFLICT (scope) DO UPDATE SET mention_id = EXCLUDED.mention_id, reviewed = EXCLUDED.reviewed,
                      observed = NULL, due_at = EXCLUDED.due_at, failures = 0
                  `, [id, JSON.stringify(refs)]);
                } else await client.query("UPDATE perry_mentions SET state = 'done' WHERE id = $1", [id]);
                return true;
              } catch (error) {
                if (signal.aborted) throw error;
                if (row.attempts < maxAttempts) {
                  await client.query(`
                    UPDATE perry_mentions SET available_at = now() + $2 * interval '1 second' WHERE id = $1
                  `, [id, 2 ** row.attempts]);
                  return true;
                }
              }
            }
            // Quarantine this thread until an operator reconciles the failed
            // publication. Later jobs must not overtake an ambiguous old write.
            await client.query("UPDATE perry_mentions SET state = 'failed' WHERE id = $1", [id]);
            return true;
          } finally {
            if (!signal.aborted) {
              await client.query("SELECT pg_advisory_unlock(185301, hashtext($1))", [scope]);
            }
          }
        }
      }
      throw signal.reason;
    });
  }

  async pollOne(repository: {installationId: string; repoId: string}, check: (watch: ReviewWatch) => Promise<boolean>) {
    return this.session(async (client, signal) => {
      // A queued review takes precedence until a stale write is in flight.
      // Then writers must finish reconciliation before publishing a newer pair.
      const eligible = `w.due_at <= now() AND (w.observed IS NOT NULL OR NOT EXISTS (
        SELECT 1 FROM perry_mentions n WHERE n.scope = w.scope AND n.id > w.mention_id
          AND n.request->>'kind' = 'review' AND n.state <> 'done'))`;
      const args = [repository.installationId, repository.repoId];
      const candidates = await client.query<{scope:string; id:string}>(`
        SELECT w.scope, m.id FROM perry_review_watches w JOIN perry_mentions m ON m.id = w.mention_id
        WHERE m.request->>'installationId' = $1 AND m.request->>'repoId' = $2 AND ${eligible}
        ORDER BY w.due_at, w.mention_id LIMIT 16
      `, args);
      for (const {scope, id} of candidates.rows) {
        const acquired = await client.query<{locked:boolean}>("SELECT pg_try_advisory_lock(185301, hashtext($1)) AS locked", [scope]);
        if (!acquired.rows[0]!.locked) continue;
        try {
          const selected = await client.query<{
            request:MentionRequest; refs:Refs; observed:Observation|null; summary:string|null; findings:string|null;
          }>(`
            SELECT m.request, w.reviewed AS refs, w.observed, s.comment_id AS summary, f.comment_id AS findings
            FROM perry_review_watches w JOIN perry_mentions m ON m.id = w.mention_id
            LEFT JOIN perry_slots s ON s.scope = w.scope AND s.name = 'summary'
            LEFT JOIN perry_slots f ON f.scope = w.scope AND f.name = 'findings'
            WHERE w.scope = $1 AND w.mention_id = $2 AND ${eligible}
          `, [scope, id]);
          const row = selected.rows[0];
          if (!row) continue;
          try {
            if (!row.summary || !row.findings || !/^\d+$/.test(row.summary) || !/^\d+$/.test(row.findings)) {
              throw new Error("Both owned slots are required for review maintenance.");
            }
            const retired = await check({
              ...row, summary: row.summary, findings: row.findings, signal,
              async begin(observed) {
                signal.throwIfAborted();
                const saved = await client.query(`
                  UPDATE perry_review_watches w SET observed = $3::jsonb
                  WHERE w.scope = $1 AND w.mention_id = $2 AND w.observed IS NULL AND ${eligible}
                `, [scope, id, JSON.stringify(observed)]);
                return saved.rowCount === 1;
              },
            });
            signal.throwIfAborted();
            await client.query(`
              UPDATE perry_review_watches SET observed = NULL, failures = 0,
                due_at = CASE WHEN $3::boolean THEN NULL ELSE now() + interval '5 minutes' END
              WHERE scope = $1 AND mention_id = $2
            `, [scope, id, retired]);
          } catch (error) {
            if (signal.aborted) throw error;
            // Persist bounded backoff across restarts. A partial publication
            // retains its observation until both owned comments are confirmed.
            await client.query(`
              UPDATE perry_review_watches SET failures = least(failures + 1, 6),
                due_at = now() + least(60, 2 ^ least(failures, 6)) * interval '1 minute'
              WHERE scope = $1 AND mention_id = $2
            `, [scope, id]);
          }
          return true;
        } finally {
          if (!signal.aborted) await client.query("SELECT pg_advisory_unlock(185301, hashtext($1))", [scope]);
        }
      }
      return false;
    });
  }
}
