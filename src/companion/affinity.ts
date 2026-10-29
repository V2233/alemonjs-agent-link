import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import type { DSHBridgeConfig } from '../dsh/client';
export type AffinityScope = { platform: string; channelId: string; userId: string; personaId: string };
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const key = (scope: AffinityScope) => {
  if (Object.values(scope).some(value => !value)) throw new Error('好感度身份不完整');

  return hash(JSON.stringify([scope.platform, scope.channelId, scope.userId, scope.personaId]));
};

export const affinityLabel = (score: number): string => (score >= 90 ? '恋情未满' : score >= 80 ? '闺蜜' : score >= 60 ? '朋友' : '相识');
export class AffinityStore {
  private db: DatabaseSync;
  constructor(
    path: string,
    private now = Date.now
  ) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA busy_timeout=3000; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS affinity (scope TEXT PRIMARY KEY, channel_hash TEXT NOT NULL, score INTEGER NOT NULL, day TEXT NOT NULL, gained INTEGER NOT NULL, last_gain INTEGER NOT NULL, updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS affinity_seen (scope TEXT NOT NULL, input TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(scope,input));`);
  }
  snapshot(scope: AffinityScope) {
    const score = Number(this.db.prepare('SELECT score FROM affinity WHERE scope=?').get(key(scope))?.score ?? 50);

    return { score, label: affinityLabel(score) };
  }
  record(scope: AffinityScope, inputId: string, text: string) {
    const id = key(scope);

    if (!inputId || text.trim().length < 4 || text.trimStart().startsWith('/')) return this.snapshot(scope);
    const now = this.now();
    const day = new Date(now + 8 * 3600000).toISOString().slice(0, 10);

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const seen = this.db.prepare('INSERT OR IGNORE INTO affinity_seen VALUES(?,?,?)').run(id, hash(inputId), now);

      if (seen.changes) {
        const row = this.db.prepare('SELECT * FROM affinity WHERE scope=?').get(id);
        const gained = row?.day === day ? Number(row.gained) : 0;
        const eligible = gained < 3 && (!row || now - Number(row.last_gain) >= 600000);
        const score = Math.min(100, Number(row?.score ?? 50) + (eligible ? 1 : 0));

        this.db
          .prepare('INSERT OR REPLACE INTO affinity VALUES(?,?,?,?,?,?,?)')
          .run(id, hash(scope.channelId), score, day, gained + (eligible ? 1 : 0), eligible ? now : Number(row?.last_gain || 0), now);
      }
      this.db.exec('COMMIT');

      return this.snapshot(scope);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  purgeHash(channelHash: string): void {
    this.db.prepare('DELETE FROM affinity_seen WHERE scope IN (SELECT scope FROM affinity WHERE channel_hash=?)').run(channelHash);
    this.db.prepare('DELETE FROM affinity WHERE channel_hash=?').run(channelHash);
  }
  cleanup(days: number): void {
    const cutoff = this.now() - days * 86400000;

    this.db.prepare('DELETE FROM affinity_seen WHERE at<?').run(cutoff);
    this.db.prepare('DELETE FROM affinity WHERE updated<?').run(cutoff);
  }
  close(): void {
    this.db.close();
  }
}
const stores = new Map<string, AffinityStore>();

export const getAffinityStore = (config: DSHBridgeConfig): AffinityStore => {
  const path = join(dirname(config.workspaceRoot), 'affinity.sqlite');

  if (!stores.has(path)) stores.set(path, new AffinityStore(path));

  return stores.get(path);
};
