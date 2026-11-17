import { createHash } from "node:crypto";
import type { Pool } from "pg";
import type { RunnerScope } from "./pairing-store.ts";

function scopeIds(scope: RunnerScope): [string, string] {
  if (![scope.installationId, scope.repoId].every(id => typeof id === "string" && /^[1-9]\d{0,19}$/.test(id))) {
    throw new Error("Invalid assessment budget scope.");
  }
  return [scope.installationId, scope.repoId];
}

export class UsageStore {
  private readonly pool: Pool;
  constructor(pool: Pool) { this.pool = pool; }

  async init(): Promise<void> {
    await this.pool.query(`
      SELECT pg_advisory_xact_lock(185306, 0);
      CREATE TABLE IF NOT EXISTS perry_usage_reservations (
        installation_id text NOT NULL,
        repo_id text NOT NULL,
        key_digest text NOT NULL,
        usage_day date NOT NULL DEFAULT ((clock_timestamp() AT TIME ZONE 'UTC')::date),
        PRIMARY KEY (installation_id, repo_id, key_digest)
      );
      CREATE TABLE IF NOT EXISTS perry_usage_days (
        installation_id text NOT NULL,
        repo_id text NOT NULL,
        usage_day date NOT NULL,
        used integer NOT NULL CHECK (used > 0),
        PRIMARY KEY (installation_id, repo_id, usage_day)
      );
    `);
  }

  async reserve(scope: RunnerScope, key: string, limit: number): Promise<boolean> {
    const ids = scopeIds(scope);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000_000) throw new Error("Invalid daily assessment limit.");
    if (typeof key !== "string" || !key.trim() || Buffer.byteLength(key) > 1024) throw new Error("Invalid assessment identity.");
    const digest = createHash("sha256").update(key).digest("hex");
    const client = await this.pool.connect();
    let discard = false;
    try {
      await client.query("BEGIN");
      // The key arbitrates duplicate requests. The daily row arbitrates distinct keys
      // competing for the remaining capacity. Roll back both writes when denied.
      const decision = await client.query<{allowed: boolean}>(`
        WITH reservation AS (
          INSERT INTO perry_usage_reservations (installation_id, repo_id, key_digest)
          VALUES ($1, $2, $3) ON CONFLICT DO NOTHING
          RETURNING installation_id, repo_id, usage_day
        ), charge AS (
          INSERT INTO perry_usage_days AS d (installation_id, repo_id, usage_day, used)
          SELECT installation_id, repo_id, usage_day, 1 FROM reservation
          ON CONFLICT (installation_id, repo_id, usage_day) DO UPDATE SET used = d.used + 1
          WHERE d.used < $4 RETURNING used
        )
        SELECT NOT EXISTS (SELECT 1 FROM reservation) OR EXISTS (SELECT 1 FROM charge) AS allowed
      `, [...ids, digest, limit]);
      const allowed = decision.rows[0]!.allowed;
      await client.query(allowed ? "COMMIT" : "ROLLBACK");
      return allowed;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { discard = true; }
      throw error;
    } finally { client.release(discard); }
  }

  async totals(scope: RunnerScope): Promise<{used: number; date: string}> {
    const result = await this.pool.query<{used: number; date: string}>(`
      WITH today AS (SELECT (statement_timestamp() AT TIME ZONE 'UTC')::date AS day)
      SELECT coalesce(d.used, 0) AS used, to_char(today.day, 'YYYY-MM-DD') AS date FROM today
      LEFT JOIN perry_usage_days d ON d.installation_id = $1 AND d.repo_id = $2 AND d.usage_day = today.day
    `, scopeIds(scope));
    return result.rows[0]!;
  }
}
