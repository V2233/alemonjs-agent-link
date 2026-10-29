import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { DSHBridgeConfig } from '../dsh/client';
export type OpinionScope = { platform: string; channelId: string; personaId: string };
export type OpinionInput = {
  name: string;
  kind: 'person' | 'software' | 'work' | 'food' | 'place' | 'character' | 'other';
  targetId?: string;
  dimension: string;
  perspective: 'reported' | 'direct' | 'inferred';
  author: string;
  quote: string;
  comment: string;
  delta: number;
};
export type OpinionEvent = OpinionInput & { id: string; objectId: string; inputId: string; at: number; revoked: boolean };
export type OpinionObject = OpinionScope & {
  id: string;
  name: string;
  kind: string;
  targetId: string;
  frozen: boolean;
  revision: number;
  events: OpinionEvent[];
};
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

export const opinionLabel = (score: number | null) =>
  score === null ? '未形成看法' : score < 20 ? '强烈反感' : score < 40 ? '不喜欢' : score < 60 ? '中立或评价混合' : score < 80 ? '认可' : '强烈偏爱';
export const opinionSummary = (object: OpinionObject) => {
  const dimensions = new Map<string, number>();
  const daily = new Map<string, number>();
  const events = object.events.map(event => {
    const before = dimensions.get(event.dimension) ?? 50;
    const day = new Date(event.at + 8 * 3600000).toISOString().slice(0, 10);
    const used = daily.get(day) || 0;
    const change = event.revoked || event.perspective === 'reported' ? 0 : Math.sign(event.delta) * Math.min(Math.abs(event.delta), 10 - used);

    if (!event.revoked && event.perspective !== 'reported') {
      dimensions.set(event.dimension, Math.max(0, Math.min(100, before + change)));
      daily.set(day, used + Math.abs(change));
    }

    return {
      ...event,
      before: event.perspective === 'reported' ? null : before,
      after: event.perspective === 'reported' ? null : (dimensions.get(event.dimension) ?? before)
    };
  });
  const score = dimensions.size ? Math.round([...dimensions.values()].reduce((a, b) => a + b, 0) / dimensions.size) : null;

  return { ...object, score, label: opinionLabel(score), dimensions: Object.fromEntries(dimensions), events };
};
export class OpinionStore {
  private db: DatabaseSync;
  constructor(
    path: string,
    private now = Date.now
  ) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(
      'PRAGMA busy_timeout=3000; PRAGMA secure_delete=ON; CREATE TABLE IF NOT EXISTS opinions (id TEXT PRIMARY KEY, channel_hash TEXT NOT NULL, payload TEXT NOT NULL)'
    );
  }
  list(scope?: OpinionScope) {
    return this.db
      .prepare('SELECT payload FROM opinions')
      .all()
      .map(row => JSON.parse(String(row.payload)) as OpinionObject)
      .filter(item => !scope || (item.platform === scope.platform && item.channelId === scope.channelId && item.personaId === scope.personaId))
      .map(opinionSummary)
      .sort((a, b) => b.revision - a.revision);
  }
  private read(id: string): OpinionObject | undefined {
    const row = this.db.prepare('SELECT payload FROM opinions WHERE id=?').get(id);

    return row ? JSON.parse(String(row.payload)) : undefined;
  }
  private write(object: OpinionObject) {
    this.db.prepare('INSERT OR REPLACE INTO opinions VALUES(?,?,?)').run(object.id, hash(object.channelId), JSON.stringify(object));
  }
  record(scope: OpinionScope, inputId: string, input: OpinionInput) {
    if (
      Object.values(scope).some(v => typeof v !== 'string' || !v) ||
      !inputId ||
      !['person', 'software', 'work', 'food', 'place', 'character', 'other'].includes(input.kind) ||
      !['reported', 'direct', 'inferred'].includes(input.perspective) ||
      !Number.isInteger(input.delta) ||
      Math.abs(input.delta) > 5 ||
      (input.perspective === 'reported' && input.delta !== 0) ||
      (input.perspective === 'inferred' && (input.kind === 'person' || Math.abs(input.delta) > 1))
    )
      throw new Error('评价格式无效');
    for (const [value, max] of [
      [input.name, 80],
      [input.dimension, 40],
      [input.author, 200],
      [input.quote, 1000],
      [input.comment, 500]
    ] as const)
      if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('评价内容无效');
    if (input.kind === 'person' && !input.targetId) throw new Error('人物必须有已核实平台ID');
    const id = hash(JSON.stringify([scope.platform, scope.channelId, scope.personaId, input.kind, input.targetId || input.name.trim().toLowerCase()]));

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const object = this.read(id) || {
        ...scope,
        id,
        name: input.name.trim(),
        kind: input.kind,
        targetId: input.targetId || '',
        frozen: false,
        revision: 0,
        events: []
      };

      // Same quoted evidence cannot be amplified through message replays or copy/paste.
      if (
        !object.frozen &&
        !object.events.some(
          e =>
            e.perspective === input.perspective &&
            e.dimension === input.dimension &&
            e.author === input.author &&
            (e.inputId === inputId || e.quote === input.quote)
        )
      ) {
        object.events.push({ ...input, id: randomUUID(), objectId: id, inputId, at: this.now(), revoked: false });
        object.revision = Math.max(this.now(), object.revision + 1);
        this.write(object);
      }
      this.db.exec('COMMIT');

      return opinionSummary(object);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  edit(id: string, revision: number, action: string, value?: string) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const object = this.read(id);

      if (object?.revision !== revision) {
        throw new Error('配置已更新');
      }
      if (action === 'freeze') object.frozen = true;
      else if (action === 'unfreeze') object.frozen = false;
      else if (action === 'rename' && typeof value === 'string' && value.trim() && value.length <= 80) object.name = value.trim();
      else if (action === 'revoke') {
        const event = object.events.find(e => e.id === value);

        if (!event) throw new Error('评价事件不存在');
        event.revoked = true;
      } else throw new Error('操作无效');
      object.revision = Math.max(this.now(), object.revision + 1);
      this.write(object);
      this.db.exec('COMMIT');

      return opinionSummary(object);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  purgeHash(channelHash: string) {
    this.db.prepare('DELETE FROM opinions WHERE channel_hash=?').run(channelHash);
  }
  cleanup(days: number) {
    const cutoff = this.now() - days * 86400000;

    for (const object of this.list()) {
      const kept = object.events.filter(e => e.at >= cutoff);

      if (!kept.length) this.db.prepare('DELETE FROM opinions WHERE id=?').run(object.id);
      else if (kept.length !== object.events.length) {
        const raw = this.read(object.id);

        raw.events = kept;
        raw.revision = Math.max(this.now(), raw.revision + 1);
        this.write(raw);
      }
    }
  }
  close() {
    this.db.close();
  }
}
const stores = new Map<string, OpinionStore>();

export const getOpinionStore = (config: DSHBridgeConfig) => {
  const path = join(dirname(config.workspaceRoot), 'opinions.sqlite');

  if (!stores.has(path)) stores.set(path, new OpinionStore(path));

  return stores.get(path);
};
