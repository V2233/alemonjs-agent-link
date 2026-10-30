import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import type { DSHBridgeConfig } from '../dsh/config';

export type StickerQuotaClaim = { eventKey: string; userKey: string; maxPerHour: number; now: number };
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

/** Rolling attempt limits and event deduplication shared by processes using one data directory. */
export class StickerCollectionQuota {
  private readonly db: DatabaseSync;
  constructor(root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const path = join(root, 'sticker-auto-quota.sqlite');

    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS attempts (event_key TEXT PRIMARY KEY,user_key TEXT NOT NULL,at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS attempts_at ON attempts(at);
      CREATE INDEX IF NOT EXISTS attempts_user ON attempts(user_key);`);
  }
  close(): void {
    this.db.close();
  }
  claim(input: StickerQuotaClaim): boolean {
    if (
      typeof input.eventKey !== 'string' ||
      !input.eventKey ||
      input.eventKey.length > 4096 ||
      typeof input.userKey !== 'string' ||
      !input.userKey ||
      input.userKey.length > 4096 ||
      !Number.isSafeInteger(input.maxPerHour) ||
      input.maxPerHour < 1 ||
      input.maxPerHour > 100 ||
      !Number.isSafeInteger(input.now) ||
      input.now < 0
    )
      throw new Error('表情收集额度参数无效。');
    const event = hash(input.eventKey),
      user = hash(input.userKey);

    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM attempts WHERE at<=?').run(input.now - 3600000);
      const count = this.db.prepare('SELECT count(*) AS total,sum(CASE WHEN user_key=? THEN 1 ELSE 0 END) AS user FROM attempts').get(user);
      let accepted = false;

      // Future rows remain counted after a clock rollback; do not mint new quota.
      if (Number(count.total) < input.maxPerHour && Number(count.user) < 20) {
        accepted = Number(this.db.prepare('INSERT OR IGNORE INTO attempts(event_key,user_key,at) VALUES(?,?,?)').run(event, user, input.now).changes) === 1;
      }
      this.db.exec('COMMIT');

      return accepted;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

const processState = globalThis as typeof globalThis & { __agentLinkStickerQuota__?: { root: string; store: StickerCollectionQuota } };

export const getStickerCollectionQuota = (config: DSHBridgeConfig): StickerCollectionQuota => {
  const root = dirname(config.workspaceRoot);

  if (processState.__agentLinkStickerQuota__?.root !== root) {
    const store = new StickerCollectionQuota(root);

    processState.__agentLinkStickerQuota__?.store.close();
    processState.__agentLinkStickerQuota__ = { root, store };
  }

  return processState.__agentLinkStickerQuota__.store;
};
