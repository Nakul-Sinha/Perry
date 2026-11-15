import type { Pool, PoolClient } from "pg";
import type { MentionRequest } from "./intake.ts";

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

  async workOne(process: (request: MentionRequest, job: Job) => Promise<void>, repository?: { installationId: string; repoId: string }): Promise<boolean> {
    const client = await this.pool.connect();
    const lifetime = new AbortController();
    const lost = () => lifetime.abort(new Error("The PostgreSQL publisher session closed."));
    client.on("error", lost);
    client.on("end", lost);
    let destroy = false;
    try {
      let after = "0";
      while (!lifetime.signal.aborted) {
        const candidates = await client.query<{id: string; scope: string}>(`
          SELECT j.id, j.scope FROM perry_mentions j
          WHERE j.id > $1 AND j.state = 'pending' AND j.available_at <= now()
            AND ($2::text IS NULL OR (j.request->>'installationId' = $2 AND j.request->>'repoId' = $3))
            AND NOT EXISTS (SELECT 1 FROM perry_mentions p WHERE p.scope = j.scope AND p.id < j.id AND p.state <> 'done')
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
              RETURNING request, attempts
            `, [id]);
            const row = claimed.rows[0];
            if (!row) continue;
            if (row.attempts <= maxAttempts) {
              try {
                await process(row.request, createJob(client, id, scope, row.request, lifetime.signal));
                lifetime.signal.throwIfAborted();
                await client.query("UPDATE perry_mentions SET state = 'done' WHERE id = $1", [id]);
                return true;
              } catch (error) {
                if (lifetime.signal.aborted) throw error;
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
            if (!lifetime.signal.aborted) {
              await client.query("SELECT pg_advisory_unlock(185301, hashtext($1))", [scope]);
            }
          }
        }
      }
      throw lifetime.signal.reason;
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
}
