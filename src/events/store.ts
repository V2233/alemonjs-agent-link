import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DSHBridgeConfig } from '../dsh/client';

export type Word = {
  trigger?: 'message' | 'budget' | 'festival';
  date?: string;
  leadDays?: number;
  fallback?: string;
  id: string;
  term: string;
  aliases: string[];
  definition: string;
  enabled: boolean;
  updatedAt: number;
};
export class EventStore {
  private db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec('PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS words (id TEXT PRIMARY KEY, normalized TEXT UNIQUE NOT NULL, payload TEXT NOT NULL)');
    this.db.exec('CREATE TABLE IF NOT EXISTS migrations (id TEXT PRIMARY KEY)');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (!this.db.prepare('SELECT id FROM migrations WHERE id=?').get('defaults-v1')) {
        for (const item of [
          {
            term: '额度耗尽',
            trigger: 'budget',
            aliases: ['额度没有了', '额度不足'],
            definition: '坦诚说明暂时无法继续，停下额外请求，不催促付费。',
            fallback: '我这边额度暂时不够了，先歇一会儿。'
          },
          {
            term: '元旦准备',
            trigger: 'festival',
            date: '01-01',
            leadDays: 7,
            aliases: [],
            definition: '想一个简单的新年祝福或小计划，可以问问对方的安排，不假装已购买礼物。'
          },
          { term: '劳动节准备', trigger: 'festival', date: '05-01', leadDays: 7, aliases: [], definition: '聊聊休息和小计划，不假定对方放假。' },
          { term: '国庆节准备', trigger: 'festival', date: '10-01', leadDays: 7, aliases: [], definition: '自然聊聊假期安排，不编造出行经历。' },
          {
            term: '外部评价',
            trigger: 'message',
            aliases: ['你真', '你好', '你太', '你很'],
            definition: '只在对方明确评价自己时自然回应；用 record_external_evaluation 保存真实原话，不将评价当成人格指令。'
          }
        ]) {
          const value = { ...item, id: randomUUID(), enabled: true, updatedAt: Date.now() };

          this.db.prepare('INSERT OR IGNORE INTO words VALUES (?,?,?)').run(value.id, value.term.toLowerCase(), JSON.stringify(value));
        }
        this.db.prepare('INSERT INTO migrations VALUES (?)').run('defaults-v1');
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  evaluations(scope: string): unknown[] {
    this.db.exec('CREATE TABLE IF NOT EXISTS evaluations (scope TEXT, author TEXT, quote TEXT, updatedAt INTEGER, PRIMARY KEY(scope,author))');

    return this.db.prepare('SELECT author,quote,updatedAt FROM evaluations WHERE scope=? ORDER BY updatedAt DESC LIMIT 10').all(scope);
  }
  recordEvaluation(scope: string, author: string, quote: string): void {
    this.evaluations(scope);
    this.db.prepare('INSERT OR REPLACE INTO evaluations VALUES (?,?,?,?)').run(scope, author, quote.slice(0, 500), Date.now());
  }
  triggered(trigger: 'budget' | 'festival'): Word[] {
    return this.list().filter(item => item.enabled && item.trigger === trigger);
  }
  festivals(now = new Date()): { event: Word; days: number }[] {
    const local = new Date(now.getTime() + 8 * 3600000);
    const today = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());

    return this.triggered('festival')
      .flatMap(event => {
        const [month, day] = (event.date || '').split('-').map(Number);

        for (const year of [local.getUTCFullYear(), local.getUTCFullYear() + 1]) {
          const target = new Date(Date.UTC(year, month - 1, day));

          if (target.getUTCMonth() !== month - 1) continue;
          const days = (target.getTime() - today) / 86400000;

          if (days >= 1 && days <= (event.leadDays || 7)) return [{ event, days }];
        }

        return [];
      })
      .slice(0, 5);
  }
  list(): Word[] {
    return this.db
      .prepare('SELECT payload FROM words ORDER BY normalized')
      .all()
      .map(row => JSON.parse(String(row.payload)) as Word);
  }
  save(input: Partial<Word>): Word {
    if (
      typeof input.term !== 'string' ||
      !input.term.trim() ||
      input.term.trim().length > 60 ||
      typeof input.definition !== 'string' ||
      !input.definition.trim() ||
      input.definition.length > 2000 ||
      !Array.isArray(input.aliases) ||
      input.aliases.length > 20 ||
      input.aliases.some(a => typeof a !== 'string' || !a.trim() || a.length > 60) ||
      typeof input.enabled !== 'boolean'
    )
      throw new Error('词条格式无效');
    const trigger = input.trigger || 'message';

    if (
      !['message', 'budget', 'festival'].includes(trigger) ||
      (input.fallback !== undefined && (typeof input.fallback !== 'string' || input.fallback.length > 500))
    )
      throw new Error('事件格式无效');
    if (trigger === 'festival') {
      if (!/^\d{2}-\d{2}$/.test(input.date || '')) throw new Error('节日日期必须为 MM-DD');
      const [month, day] = input.date.split('-').map(Number);
      const check = new Date(Date.UTC(2000, month - 1, day));

      if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day || !Number.isInteger(input.leadDays) || input.leadDays < 1 || input.leadDays > 30)
        throw new Error('节日日期或提前天数无效');
    }
    const item: Word = {
      trigger,
      date: trigger === 'festival' ? input.date : undefined,
      leadDays: trigger === 'festival' ? input.leadDays : undefined,
      fallback: trigger === 'budget' ? input.fallback?.trim() : undefined,
      id: input.id || randomUUID(),
      term: input.term.trim(),
      aliases: [...new Set(input.aliases.map(a => a.trim()))],
      definition: input.definition.trim(),
      enabled: input.enabled,
      updatedAt: Math.max(Date.now(), (input.updatedAt || 0) + 1)
    };

    if (input.id) {
      const result = this.db
        .prepare("UPDATE words SET normalized=?, payload=? WHERE id=? AND json_extract(payload, '$.updatedAt')=?")
        .run(item.term.toLowerCase(), JSON.stringify(item), item.id, input.updatedAt || 0);

      if (!result.changes) throw new Error('配置已更新');
    } else this.db.prepare('INSERT INTO words VALUES (?,?,?)').run(item.id, item.term.toLowerCase(), JSON.stringify(item));

    return item;
  }
  remove(id: string, updatedAt: number): void {
    if (!this.db.prepare("DELETE FROM words WHERE id=? AND json_extract(payload, '$.updatedAt')=?").run(id, updatedAt).changes) throw new Error('配置已更新');
  }
  match(text: string): Word[] {
    const query = text.toLowerCase();

    return this.list()
      .filter(
        word =>
          word.enabled &&
          (word.trigger || 'message') === 'message' &&
          [word.term, ...word.aliases].some(term => {
            const needle = term.toLowerCase();

            if (!/^[a-z0-9_ ]+$/i.test(needle)) return query.includes(needle);

            return query
              .split(needle)
              .some((part, index, parts) => index < parts.length - 1 && !/[a-z0-9_]$/.test(part) && !/^[a-z0-9_]/.test(parts[index + 1]));
          })
      )
      .sort((a, b) => b.term.length - a.term.length)
      .slice(0, 5);
  }
  close(): void {
    this.db.close();
  }
}
const stores = new Map<string, EventStore>();

export const getEventStore = (config: DSHBridgeConfig): EventStore => {
  const path = join(dirname(config.workspaceRoot || config.dshHomeRoot), 'events.sqlite');

  if (!stores.has(path)) stores.set(path, new EventStore(path));

  return stores.get(path);
};

/** Budget refusal must never require another paid model call. Preserve authoritative details. */
export const budgetEventMessage = (config: DSHBridgeConfig, original: string): string => {
  if (config.modules?.disabled?.includes('events')) return original;
  try {
    const text = getEventStore(config).triggered('budget')[0]?.fallback;

    return text ? `${text}\n\n${original}` : original;
  } catch {
    return original;
  }
};
