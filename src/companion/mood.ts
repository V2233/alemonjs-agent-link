import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { DSHBridgeConfig } from '../dsh/client';
import type { PersonaScope } from './personas';

export type MoodOptions = { baseline: number; halfLifeHours: number; modelJudge: boolean };
export const moodOptions = (config: DSHBridgeConfig): MoodOptions => {
  const raw = config.modules?.settings?.mood || {};
  // 默认开启模型心情判定；如不想承担额外请求，可显式设 modelJudge: false。
  const result = { baseline: raw.baseline ?? 60, halfLifeHours: raw.halfLifeHours ?? 6, modelJudge: raw.modelJudge ?? true };

  if (
    !Number.isFinite(result.baseline) ||
    Number(result.baseline) < 20 ||
    Number(result.baseline) > 80 ||
    !Number.isFinite(result.halfLifeHours) ||
    Number(result.halfLifeHours) < 0.1 ||
    Number(result.halfLifeHours) > 168 ||
    typeof result.modelJudge !== 'boolean'
  ) {
    throw new Error('mood 模块设置无效。');
  }

  return { baseline: Number(result.baseline), halfLifeHours: Number(result.halfLifeHours), modelJudge: result.modelJudge };
};
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const key = (scope: PersonaScope): string => {
  if (!scope.platform || !scope.channelId) {
    throw new Error('心情缺少会话标识。');
  }

  return digest(JSON.stringify([scope.platform, scope.channelId]));
};
const bound = (value: number): number => Math.max(0, Math.min(100, value));

export const moodLabel = (value: number): string => (value >= 75 ? '愉快' : value >= 45 ? '平和' : value >= 25 ? '低落' : '疲惫');
// Only explicit address forms affect the state; the user's own distress is not an insult.
export const keywordMoodDelta = (text: string): number => {
  if (text.length > 500 || /[“”「」<>]|不是|并不|没有|别说|不要说|他说|她说|有人说/u.test(text) || text.trimStart().startsWith('/')) {
    return 0;
  }
  if (/^(?:你(?:这个|真是|就是)?(?:笨蛋|废物|傻逼)|闭嘴|滚开)[！!。，,\s]*$/u.test(text.trim())) {
    return -6;
  }
  if (/^(?:谢谢你|你真棒|你太棒了|辛苦你了|喜欢你|你真可爱)[！!。，,呀啊呢\s]*$/u.test(text.trim())) {
    return 4;
  }

  return 0;
};
export type MoodSnapshot = { value: number; label: string; token?: string };
export class MoodStore {
  private readonly db: DatabaseSync;

  constructor(
    root: string,
    private readonly now: () => number = Date.now
  ) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const path = join(root, 'moods.sqlite');

    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA busy_timeout=3000; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS moods(scope TEXT PRIMARY KEY,channel_hash TEXT NOT NULL,value REAL NOT NULL,at INTEGER NOT NULL,
        token TEXT NOT NULL,last_keyword_at INTEGER NOT NULL,keyword_delta REAL NOT NULL,model_done INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS mood_inputs(scope TEXT NOT NULL,input_hash TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(scope,input_hash));
      CREATE TABLE IF NOT EXISTS mood_history(seq INTEGER PRIMARY KEY,scope TEXT NOT NULL,at INTEGER NOT NULL,value REAL NOT NULL,delta REAL NOT NULL,source TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS mood_history_scope ON mood_history(scope,seq);`);
  }

  close(): void {
    this.db.close();
  }

  private value(row: Record<string, unknown> | undefined, options: MoodOptions): number {
    return row
      ? bound(options.baseline + (Number(row.value) - options.baseline) * 2 ** (-Math.max(0, this.now() - Number(row.at)) / (options.halfLifeHours * 3600000)))
      : options.baseline;
  }

  snapshot(scope: PersonaScope, options: MoodOptions, retentionDays = 30): MoodSnapshot {
    this.expire(key(scope), retentionDays);
    const row = this.db.prepare('SELECT * FROM moods WHERE scope=?').get(key(scope));
    const value = this.value(row, options);

    return { value, label: moodLabel(value), token: row ? String(row.token) : undefined };
  }

  observe(scope: PersonaScope, inputId: string, delta: number, options: MoodOptions, retentionDays = 30): MoodSnapshot {
    if (!inputId || !Number.isFinite(delta)) {
      throw new Error('心情输入无效。');
    }
    const scopeId = key(scope);

    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.expire(scopeId, retentionDays);
      const previous = this.db.prepare('SELECT * FROM moods WHERE scope=?').get(scopeId);
      const now = this.now();
      const seen = this.db.prepare('INSERT OR IGNORE INTO mood_inputs(scope,input_hash,at) VALUES(?,?,?)').run(scopeId, digest(inputId), now);
      const before = this.value(previous, options);

      if (!Number(seen.changes)) {
        this.db.exec('COMMIT');

        // A retried old input must not judge the most recent input's mood.
        return { value: before, label: moodLabel(before) };
      }
      const applied = previous && now - Number(previous.last_keyword_at) < 10000 ? 0 : Math.max(-6, Math.min(4, delta));
      const value = bound(before + applied);
      const token = randomUUID();

      this.db
        .prepare(
          `INSERT INTO moods VALUES(?,?,?,?,?,?,?,0) ON CONFLICT(scope) DO UPDATE SET
        value=excluded.value,at=excluded.at,token=excluded.token,last_keyword_at=excluded.last_keyword_at,keyword_delta=excluded.keyword_delta,model_done=0`
        )
        .run(scopeId, digest(scope.channelId), value, now, token, applied ? now : Number(previous?.last_keyword_at || 0), applied);
      if (applied) {
        this.record(scopeId, value, value - before, 'keyword');
      }
      this.db
        .prepare(
          'DELETE FROM mood_inputs WHERE scope=? AND input_hash NOT IN (SELECT input_hash FROM mood_inputs WHERE scope=? ORDER BY at DESC,rowid DESC LIMIT 256)'
        )
        .run(scopeId, scopeId);
      this.db.exec('COMMIT');

      return { value, label: moodLabel(value), token };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  applyModel(scope: PersonaScope, token: string, delta: number, options: MoodOptions): boolean {
    if (!Number.isFinite(delta) || Math.abs(delta) > 6) {
      return false;
    }
    const scopeId = key(scope);

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT * FROM moods WHERE scope=? AND token=? AND model_done=0').get(scopeId, token);

      if (!row) {
        this.db.exec('COMMIT');

        return false;
      }
      const before = this.value(row, options);
      // The model estimates the total impact of this input, rather than adding it twice.
      const value = bound(before + delta - Number(row.keyword_delta));

      this.db.prepare('UPDATE moods SET value=?,at=?,model_done=1 WHERE scope=? AND token=?').run(value, this.now(), scopeId, token);
      if (value !== before) {
        this.record(scopeId, value, value - before, 'model');
      }
      this.db.exec('COMMIT');

      return true;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  history(scope: PersonaScope): { at: number; value: number; delta: number; source: string }[] {
    return this.db.prepare('SELECT at,value,delta,source FROM mood_history WHERE scope=? ORDER BY seq DESC LIMIT 20').all(key(scope)) as never;
  }

  private record(scope: string, value: number, delta: number, source: string): void {
    this.db.prepare('INSERT INTO mood_history(scope,at,value,delta,source) VALUES(?,?,?,?,?)').run(scope, this.now(), value, delta, source);
    this.db
      .prepare('DELETE FROM mood_history WHERE scope=? AND seq NOT IN (SELECT seq FROM mood_history WHERE scope=? ORDER BY seq DESC LIMIT 20)')
      .run(scope, scope);
  }

  private remove(scope: string): void {
    this.db.prepare('DELETE FROM moods WHERE scope=?').run(scope);
    this.db.prepare('DELETE FROM mood_inputs WHERE scope=?').run(scope);
    this.db.prepare('DELETE FROM mood_history WHERE scope=?').run(scope);
  }

  private expire(scope: string, days: number): void {
    const row = this.db.prepare('SELECT at FROM moods WHERE scope=?').get(scope);

    if (row && Number(row.at) < this.now() - days * 86400000) {
      this.remove(scope);
    }
  }

  cleanup(days: number): void {
    const rows = this.db.prepare('SELECT scope FROM moods WHERE at<?').all(this.now() - days * 86400000);

    for (const row of rows) {
      this.remove(String(row.scope));
    }
  }

  purgeHash(hash: string): void {
    const rows = this.db.prepare('SELECT scope FROM moods WHERE channel_hash=?').all(hash);

    for (const row of rows) {
      this.remove(String(row.scope));
    }
  }
}

const state = globalThis as typeof globalThis & { __agentLinkMoods__?: Map<string, MoodStore> };
const stores = (state.__agentLinkMoods__ ??= new Map<string, MoodStore>());

export const getMoodStore = (config: DSHBridgeConfig): MoodStore => {
  const root = dirname(config.workspaceRoot);
  let store = stores.get(root);

  if (!store) {
    store = new MoodStore(root);
    stores.set(root, store);
  }

  return store;
};
