import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";

export interface RunnerScope {installationId: string; repoId: string}

const opaque = /^[A-Za-z0-9_-]{43}$/;
const runnerId = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

function scopeValues(scope: RunnerScope) {
  if (![scope.installationId, scope.repoId].every(value => /^[1-9]\d{0,19}$/.test(value))) {
    throw new Error("Invalid runner enrollment scope.");
  }
  return [scope.installationId, scope.repoId];
}

export class PairingStore {
  private readonly pool: Pool;
  constructor(pool: Pool) {this.pool = pool;}

  async init(): Promise<void> {
    await this.pool.query(`
      SELECT pg_advisory_xact_lock(185304, 0);
      CREATE TABLE IF NOT EXISTS perry_pairing_codes (
        code_digest text PRIMARY KEY,
        installation_id text NOT NULL,
        repo_id text NOT NULL,
        expires_at timestamptz NOT NULL
      );
      CREATE TABLE IF NOT EXISTS perry_runners (
        id uuid PRIMARY KEY,
        installation_id text NOT NULL,
        repo_id text NOT NULL,
        token_digest text UNIQUE NOT NULL,
        revoked_at timestamptz
      );
    `);
  }

  // The caller must authorize the operator before issuing enrollment access.
  async issue(scope: RunnerScope): Promise<{code: string; expiresAt: Date}> {
    const values = scopeValues(scope);
    const code = randomBytes(32).toString("base64url");
    const row = await this.pool.query<{expires_at: Date}>(`
      INSERT INTO perry_pairing_codes (installation_id, repo_id, code_digest, expires_at)
      VALUES ($1, $2, $3, clock_timestamp() + interval '10 minutes')
      RETURNING expires_at
    `, [...values, digest(code)]);
    return {code, expiresAt: row.rows[0]!.expires_at};
  }

  async pair(scope: RunnerScope, code: string): Promise<{runnerId: string; token: string} | null> {
    const values = scopeValues(scope);
    if (!opaque.test(code)) return null;
    const id = randomUUID();
    const token = randomBytes(32).toString("base64url");
    // Consumption and insertion share a statement/transaction. An insertion
    // failure rolls back consumption; concurrent exchanges consume at most once.
    const row = await this.pool.query<{id: string}>(`
      WITH consumed AS (
        DELETE FROM perry_pairing_codes
        WHERE installation_id = $1 AND repo_id = $2 AND code_digest = $3
          AND expires_at > clock_timestamp()
        RETURNING installation_id, repo_id
      )
      INSERT INTO perry_runners (id, installation_id, repo_id, token_digest)
      SELECT $4::uuid, installation_id, repo_id, $5 FROM consumed
      RETURNING id
    `, [...values, digest(code), id, digest(token)]);
    return row.rowCount === 1 ? {runnerId: row.rows[0]!.id, token} : null;
  }

  async identify(scope: RunnerScope, token: string): Promise<string | null> {
    const values = scopeValues(scope);
    if (!opaque.test(token)) return null;
    const row = await this.pool.query<{id: string}>(`
      SELECT id FROM perry_runners
      WHERE installation_id = $1 AND repo_id = $2 AND token_digest = $3 AND revoked_at IS NULL
    `, [...values, digest(token)]);
    return row.rows[0]?.id ?? null;
  }

  async revoke(scope: RunnerScope, id: string): Promise<boolean> {
    const values = scopeValues(scope);
    if (!runnerId.test(id)) return false;
    const row = await this.pool.query(`
      UPDATE perry_runners SET revoked_at = clock_timestamp()
      WHERE installation_id = $1 AND repo_id = $2 AND id = $3::uuid AND revoked_at IS NULL
    `, [...values, id]);
    return row.rowCount === 1;
  }
}
