import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { DSHBridgeConfig } from '../dsh/client';
import { rankMemories, rankMemoriesHybrid } from './retrieval';
import type { EmbeddingClient } from './embedding';

export type MemoryScope = { platform: string; channelId: string };
export type MemorySource = { seq: number; speakerId: string; speaker: string; text: string; timestamp: number };
export type MemoryKind = 'fact' | 'insight' | 'style' | 'event' | 'diary';
export type MemoryItem = {
  id: string;
  subjectId: string;
  subjectName: string;
  kind: MemoryKind;
  text: string;
  tags: string[];
  importance: number;
  confidence: number;
  status: 'active' | 'outdated';
  origin: 'explicit' | 'extracted' | 'event' | 'diary';
  sourceRefs: MemorySource[];
  supersedes: string[];
  createdAt: number;
  updatedAt: number;
  lastRecalledAt: number;
  recallDays: number;
};
export type MemoryChange = {
  action: 'add' | 'merge' | 'replace';
  targetId?: string;
  text: string;
  kind: 'fact' | 'insight' | 'style';
  sourceSeqs: number[];
  evidence: string;
  tags: string[];
  importance: number;
  confidence: number;
};
export type MemoryGuard = { epoch: string; revision: number; checkpoint?: number };
const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
const normalize = (text: string): string =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{Z}\s]/gu, '');
const scopeKey = (scope: MemoryScope): string => {
  if (!scope.platform || !scope.channelId) {
    throw new Error('记忆缺少平台或会话标识。');
  }

  return hash(JSON.stringify([scope.platform, scope.channelId]));
};

const connectedMemoryIds = (items: MemoryItem[], target: MemoryItem, includeEvidence: boolean): Set<string> => {
  const edges = new Map<string, Set<string>>();
  const sourceOwners = new Map<number, string>();
  const textOwners = new Map<string, string>();
  const connect = (one: string, two: string): void => {
    if (!edges.has(one)) {
      edges.set(one, new Set());
    }
    if (!edges.has(two)) {
      edges.set(two, new Set());
    }
    edges.get(one).add(two);
    edges.get(two).add(one);
  };

  for (const item of items.filter(entry => entry.subjectId === target.subjectId)) {
    item.supersedes.forEach(parent => connect(item.id, parent));
    if (!includeEvidence) {
      continue;
    }
    const normalized = normalize(item.text);
    const sameText = textOwners.get(normalized);

    if (sameText) {
      connect(item.id, sameText);
    }
    textOwners.set(normalized, item.id);
    for (const source of item.sourceRefs) {
      const sameSource = sourceOwners.get(source.seq);

      if (sameSource) {
        connect(item.id, sameSource);
      }
      sourceOwners.set(source.seq, item.id);
    }
  }
  const found = new Set([target.id]);
  const queue = [target.id];

  for (let index = 0; index < queue.length; index++) {
    for (const next of edges.get(queue[index]) || []) {
      if (found.has(next)) {
        continue;
      }
      found.add(next);
      queue.push(next);
    }
  }

  return found;
};

export class MemoryStore {
  private readonly db: DatabaseSync;

  constructor(
    path: string,
    private readonly now = Date.now
  ) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA busy_timeout=3000; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS memory_scopes (
        scope TEXT PRIMARY KEY, platform TEXT NOT NULL, channel_id TEXT NOT NULL, group_hash TEXT NOT NULL,
        epoch TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, checkpoint INTEGER NOT NULL DEFAULT 0,
        last_run INTEGER NOT NULL DEFAULT 0, retry_after INTEGER NOT NULL DEFAULT 0, active_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS memories (
        scope TEXT NOT NULL REFERENCES memory_scopes(scope) ON DELETE CASCADE, id TEXT NOT NULL,
        subject_id TEXT NOT NULL, subject_name TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, normalized TEXT NOT NULL,
        tags TEXT NOT NULL, importance REAL NOT NULL, confidence REAL NOT NULL, status TEXT NOT NULL, origin TEXT NOT NULL,
        sources TEXT NOT NULL, supersedes TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        last_recalled_at INTEGER NOT NULL DEFAULT 0, recall_days INTEGER NOT NULL DEFAULT 0, recall_day TEXT NOT NULL DEFAULT '',
        embedding BLOB, embedding_model TEXT, embedding_hash TEXT,
        PRIMARY KEY(scope,id));
      CREATE INDEX IF NOT EXISTS memory_status ON memories(scope,status,subject_id);
      CREATE INDEX IF NOT EXISTS memory_groups ON memory_scopes(group_hash);
      CREATE TABLE IF NOT EXISTS memory_recalls (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL REFERENCES memory_scopes(scope) ON DELETE CASCADE,
        at INTEGER NOT NULL, ids TEXT NOT NULL);`);
    const columns = new Set(
      this.db
        .prepare('PRAGMA table_info(memories)')
        .all()
        .map(row => String(row.name))
    );

    for (const [name, type] of [
      ['embedding', 'BLOB'],
      ['embedding_model', 'TEXT'],
      ['embedding_hash', 'TEXT']
    ] as const) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE memories ADD COLUMN ${name} ${type}`);
    }
  }

  close(): void {
    this.db.close();
  }

  private transaction<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = run();

      this.db.exec('COMMIT');

      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  observe(scope: MemoryScope): void {
    const key = scopeKey(scope);
    const previous = this.db.prepare('SELECT active_at FROM memory_scopes WHERE scope=?').get(key);

    if (previous && Number(previous.active_at) < this.now() - 30 * 86400000) {
      this.db.prepare('DELETE FROM memory_scopes WHERE scope=?').run(key);
    }
    this.db
      .prepare(
        `INSERT INTO memory_scopes(scope,platform,channel_id,group_hash,epoch,active_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(scope) DO UPDATE SET active_at=excluded.active_at`
      )
      .run(key, scope.platform, scope.channelId, hash(scope.channelId), randomUUID(), this.now());
  }

  state(scope: MemoryScope): (MemoryGuard & { checkpoint: number; lastRun: number; retryAfter: number }) | undefined {
    const row = this.db
      .prepare('SELECT epoch,revision,checkpoint,last_run AS lastRun,retry_after AS retryAfter FROM memory_scopes WHERE scope=?')
      .get(scopeKey(scope));

    return row ? (row as unknown as MemoryGuard & { checkpoint: number; lastRun: number; retryAfter: number }) : undefined;
  }

  due(intervalMs: number, limit = 4): MemoryScope[] {
    return this.db
      .prepare(
        `SELECT platform,channel_id AS channelId FROM memory_scopes WHERE last_run<=? AND retry_after<=?
      ORDER BY last_run,active_at DESC LIMIT ?`
      )
      .all(this.now() - intervalMs, this.now(), limit) as unknown as MemoryScope[];
  }

  private decode(row: Record<string, unknown>): MemoryItem {
    return {
      id: String(row.id),
      subjectId: String(row.subject_id),
      subjectName: String(row.subject_name),
      kind: row.kind as MemoryKind,
      text: String(row.text),
      tags: JSON.parse(String(row.tags)),
      importance: Number(row.importance),
      confidence: Number(row.confidence),
      status: row.status as MemoryItem['status'],
      origin: row.origin as MemoryItem['origin'],
      sourceRefs: JSON.parse(String(row.sources)),
      supersedes: JSON.parse(String(row.supersedes)),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      lastRecalledAt: Number(row.last_recalled_at),
      recallDays: Number(row.recall_days)
    };
  }

  list(scope: MemoryScope, options: { status?: 'active' | 'outdated'; subjectId?: string; limit?: number; before?: number } = {}): MemoryItem[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM memories WHERE scope=? AND (?='' OR status=?) AND (?='' OR subject_id=?)
      AND created_at<=? ORDER BY created_at DESC,id LIMIT ?`
      )
      .all(
        scopeKey(scope),
        options.status || '',
        options.status || '',
        options.subjectId || '',
        options.subjectId || '',
        options.before ?? Number.MAX_SAFE_INTEGER,
        Math.max(1, Math.min(10020, options.limit ?? 100))
      );

    return rows.map(row => this.decode(row));
  }

  get(scope: MemoryScope, id: string): MemoryItem | undefined {
    const row = this.db.prepare('SELECT * FROM memories WHERE scope=? AND id=?').get(scopeKey(scope), id);

    return row ? this.decode(row) : undefined;
  }

  recordExperience(scope: MemoryScope, input: { key: string; subjectId: string; text: string; tags: string[] }, guard?: MemoryGuard): boolean {
    if (
      !input.key ||
      input.key.length > 500 ||
      !input.subjectId ||
      input.subjectId.length > 200 ||
      !input.text.trim() ||
      input.text.length > 800 ||
      input.tags.length > 10 ||
      input.tags.some(tag => typeof tag !== 'string' || tag.length > 40)
    ) {
      throw new Error('经历资料无效。');
    }
    this.observe(scope);

    return this.transaction(() => {
      const key = scopeKey(scope);
      const state = this.state(scope);

      if (guard && (state?.epoch !== guard.epoch || state?.revision !== guard.revision)) return false;
      const id = hash(JSON.stringify(['experience', input.key])).slice(0, 12);

      if (this.db.prepare('SELECT id FROM memories WHERE scope=? AND id=?').get(key, id)) return false;
      const capacity = scope.channelId.startsWith('private:') ? 1980 : 2000;
      const active = this.db.prepare("SELECT count(*) AS n FROM memories WHERE scope=? AND origin<>'explicit' AND status='active'").get(key);
      const total = this.db.prepare("SELECT count(*) AS n FROM memories WHERE scope=? AND origin<>'explicit'").get(key);

      if (Number(active.n) >= capacity || Number(total.n) >= 10000) return false;
      this.insert(scope, {
        id,
        subjectId: input.subjectId,
        subjectName: '机器人',
        kind: 'event',
        text: input.text.trim(),
        tags: input.tags,
        importance: 0.5,
        confidence: 1,
        status: 'active',
        origin: 'event',
        sourceRefs: [],
        supersedes: [],
        createdAt: this.now(),
        updatedAt: this.now(),
        lastRecalledAt: 0,
        recallDays: 0
      });
      this.db.prepare('UPDATE memory_scopes SET revision=revision+1 WHERE scope=?').run(key);

      return true;
    });
  }

  private insert(scope: MemoryScope, item: MemoryItem): void {
    this.db
      .prepare(
        `INSERT INTO memories(scope,id,subject_id,subject_name,kind,text,normalized,tags,importance,confidence,status,origin,sources,supersedes,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(scope,id) DO UPDATE SET
      text=excluded.text,normalized=excluded.normalized,tags=excluded.tags,importance=excluded.importance,
      confidence=excluded.confidence,status=excluded.status,updated_at=excluded.updated_at,
      embedding=NULL,embedding_model=NULL,embedding_hash=NULL`
      )
      .run(
        scopeKey(scope),
        item.id,
        item.subjectId,
        item.subjectName,
        item.kind,
        item.text,
        normalize(item.text),
        JSON.stringify(item.tags),
        item.importance,
        item.confidence,
        item.status,
        item.origin,
        JSON.stringify(item.sourceRefs),
        JSON.stringify(item.supersedes),
        item.createdAt,
        item.updatedAt
      );
  }

  syncExplicit(scope: MemoryScope, subjectId: string, notes: { id: string; text: string; createdAt: number }[]): void {
    if (notes.length > 20) {
      throw new Error('明确记忆超过容量限制。');
    }
    this.observe(scope);
    this.transaction(() => {
      const key = scopeKey(scope);
      const existing = this.db.prepare("SELECT id,text FROM memories WHERE scope=? AND origin='explicit' AND subject_id=?").all(key, subjectId);
      const ids = new Set(notes.map(note => note.id));
      const changed = existing.length !== notes.length || notes.some(note => !existing.some(row => row.id === note.id && row.text === note.text));

      if (!changed) {
        return;
      }
      this.db.prepare('UPDATE memory_scopes SET revision=revision+1 WHERE scope=?').run(key);

      for (const row of existing) {
        if (!ids.has(String(row.id))) {
          this.db.prepare('DELETE FROM memories WHERE scope=? AND id=?').run(key, row.id);
        }
      }
      for (const note of notes) {
        this.insert(scope, {
          id: note.id,
          subjectId,
          subjectName: '',
          kind: 'fact',
          text: note.text,
          tags: [],
          importance: 1,
          confidence: 1,
          origin: 'explicit',
          status: 'active',
          sourceRefs: [],
          supersedes: [],
          createdAt: note.createdAt,
          updatedAt: note.createdAt,
          lastRecalledAt: 0,
          recallDays: 0
        });
      }
    });
  }

  private activeDocuments(scope: MemoryScope): (MemoryItem & { embedding?: Buffer; embeddingModel?: string; embeddingHash?: string })[] {
    return this.db
      .prepare("SELECT * FROM memories WHERE scope=? AND status='active'")
      .all(scopeKey(scope))
      .map(row => ({
        ...this.decode(row),
        ...(row.embedding instanceof Uint8Array ? { embedding: Buffer.from(row.embedding) } : {}),
        embeddingModel: row.embedding_model ? String(row.embedding_model) : undefined,
        embeddingHash: row.embedding_hash ? String(row.embedding_hash) : undefined
      }));
  }

  private finishRanked(scope: MemoryScope, ranked: (MemoryItem & { score: number })[], limit: number, record: boolean): (MemoryItem & { score: number })[] {
    const key = scopeKey(scope);
    const unique = new Set<string>();
    const hits = ranked
      .filter(item => {
        const identity = `${item.subjectId}:${normalize(item.text)}`;

        if (unique.has(identity)) {
          return false;
        }
        unique.add(identity);

        return true;
      })
      .slice(0, Math.max(1, Math.min(20, limit)))
      .map(hit => ({ ...this.decode(this.db.prepare('SELECT * FROM memories WHERE scope=? AND id=?').get(key, hit.id)), score: hit.score }));

    if (record && hits.length) {
      const now = this.now();
      const day = new Date(now).toISOString().slice(0, 10);

      this.transaction(() => {
        for (const item of hits) {
          this.db
            .prepare(
              `UPDATE memories SET last_recalled_at=?, recall_days=recall_days+CASE WHEN recall_day<>? THEN 1 ELSE 0 END,recall_day=?
            WHERE scope=? AND id=?`
            )
            .run(now, day, day, key, item.id);
        }
        this.db.prepare('INSERT INTO memory_recalls(scope,at,ids) VALUES(?,?,?)').run(key, now, JSON.stringify(hits.map(item => item.id)));
        this.db
          .prepare('DELETE FROM memory_recalls WHERE scope=? AND seq NOT IN(SELECT seq FROM memory_recalls WHERE scope=? ORDER BY seq DESC LIMIT 20)')
          .run(key, key);
      });
    }

    return hits;
  }

  recall(scope: MemoryScope, query: string, subjectId: string, limit = 8, record = true): (MemoryItem & { score: number })[] {
    const documents = this.activeDocuments(scope);

    return this.finishRanked(scope, rankMemories(documents, query, subjectId, this.now()), limit, record);
  }

  /**
   * 可选语义召回：BM25 仍负责词面命中，embedding 只把“意思相近但用词不同”的
   * 条目补进候选。向量按模型与文本哈希缓存在本地；服务失败时退回 BM25。
   */
  async recallSemantic(
    scope: MemoryScope,
    query: string,
    subjectId: string,
    limit = 8,
    options: { client: EmbeddingClient; weight: number; maxItems: number; signal: AbortSignal },
    record = true
  ): Promise<(MemoryItem & { score: number })[]> {
    const documents = this.activeDocuments(scope);

    if (!documents.length || !query.trim()) {
      return this.finishRanked(scope, rankMemories(documents, query, subjectId, this.now()), limit, record);
    }
    const lexical = rankMemories(documents, query, subjectId, this.now());
    const candidates = new Map<string, (typeof documents)[number]>();

    for (const item of [...documents].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, options.maxItems)) {
      candidates.set(item.id, item);
    }
    for (const item of lexical.slice(0, 120)) {
      const document = documents.find(row => row.id === item.id);

      if (document) candidates.set(item.id, document);
    }
    const selected = [...candidates.values()];
    const vectors = new Map<string, Float32Array>();
    const missing: (typeof documents)[number][] = [];

    for (const item of selected) {
      if (item.embedding && item.embeddingModel === options.client.model && item.embeddingHash === hash(item.text) && item.embedding.length % 4 === 0) {
        vectors.set(item.id, new Float32Array(item.embedding.buffer.slice(item.embedding.byteOffset, item.embedding.byteOffset + item.embedding.byteLength)));
      } else {
        missing.push(item);
      }
    }

    try {
      options.signal.throwIfAborted();
      const embedded = await options.client.embed([query, ...missing.map(item => item.text)], options.signal);

      options.signal.throwIfAborted();
      const queryVector = embedded[0];

      missing.forEach((item, index) => {
        const vector = embedded[index + 1];

        if (vector) {
          vectors.set(item.id, vector);
        }
      });
      if (missing.length && vectors.size === selected.length) {
        this.transaction(() => {
          const statement = this.db.prepare("UPDATE memories SET embedding=?,embedding_model=?,embedding_hash=? WHERE scope=? AND id=? AND status='active'");
          const key = scopeKey(scope);

          for (const item of missing) {
            const vector = vectors.get(item.id);

            if (vector) statement.run(Buffer.from(vector.buffer), options.client.model, hash(item.text), key, item.id);
          }
        });
      }
      const hybrid = rankMemoriesHybrid(selected, lexical, queryVector, vectors, subjectId, options.weight, this.now());

      return this.finishRanked(scope, hybrid, limit, record);
    } catch (error) {
      if (options.signal.aborted) {
        throw error;
      }

      return this.finishRanked(scope, lexical, limit, record);
    }
  }

  profile(scope: MemoryScope, subjectId: string, maxChars = 600): { facts: MemoryItem[]; text: string } {
    const facts = this.list(scope, { status: 'active', subjectId, limit: 2000 })
      .filter(item => item.kind === 'fact' && item.confidence >= 0.8)
      .sort((a, b) => b.importance - a.importance || b.updatedAt - a.updatedAt);
    const selected: MemoryItem[] = [];
    let length = 0;

    for (const fact of facts) {
      if (selected.some(item => normalize(item.text) === normalize(fact.text))) {
        continue;
      }
      if (length + fact.text.length > maxChars) {
        continue;
      }
      selected.push(fact);
      length += fact.text.length;
      if (selected.length === 8) {
        break;
      }
    }

    return { facts: selected, text: selected.map(item => item.text).join('；') };
  }

  recalls(scope: MemoryScope): { at: number; ids: string[] }[] {
    return this.db
      .prepare('SELECT at,ids FROM memory_recalls WHERE scope=? ORDER BY seq DESC LIMIT 20')
      .all(scopeKey(scope))
      .map(row => ({ at: Number(row.at), ids: JSON.parse(String(row.ids)) }));
  }

  applyExtraction(
    scope: MemoryScope,
    guard: MemoryGuard,
    changes: MemoryChange[],
    sources: MemorySource[],
    checkpoint: number,
    hasMore: boolean
  ): { applied: boolean; added: number } {
    return this.transaction(() => {
      const state = this.state(scope);

      if (state?.epoch !== guard.epoch || state?.revision !== guard.revision || (guard.checkpoint !== undefined && state.checkpoint !== guard.checkpoint)) {
        return { applied: false, added: 0 };
      }
      const allowed = new Map(sources.map(source => [source.seq, source]));
      const key = scopeKey(scope);
      let added = 0;

      for (const change of changes) {
        if (
          !Number.isFinite(change.confidence) ||
          change.confidence < 0 ||
          change.confidence > 1 ||
          !Number.isFinite(change.importance) ||
          change.importance < 0 ||
          change.importance > 1 ||
          !['add', 'merge', 'replace'].includes(change.action) ||
          (change.action === 'add' && Boolean(change.targetId)) ||
          !['fact', 'insight', 'style'].includes(change.kind) ||
          !Array.isArray(change.tags) ||
          change.tags.length > 5 ||
          change.tags.some(tag => typeof tag !== 'string' || tag.length > 20)
        ) {
          throw new Error('记忆变更属性无效。');
        }
        if (change.confidence < 0.8) {
          continue;
        }
        const refs = change.sourceSeqs.map(seq => allowed.get(seq));

        if (
          !refs.length ||
          refs.some(ref => !ref) ||
          new Set(refs.map(ref => ref.speakerId)).size !== 1 ||
          !refs[0]?.speakerId ||
          !refs.some(ref => ref.text.includes(change.evidence)) ||
          !change.evidence.trim() ||
          /假设|假装|开玩笑|只是玩笑|如果我是/u.test(change.evidence)
        ) {
          throw new Error('记忆来源或证据无效。');
        }
        const subjectId = refs[0].speakerId;
        const old = change.targetId ? this.get(scope, change.targetId) : undefined;

        if (change.action !== 'add' && (old?.subjectId !== subjectId || old?.status !== 'active' || old?.origin === 'explicit')) {
          throw new Error('记忆变更目标无效，明确保存的资料需要用户手动更正。');
        }
        const text = change.action === 'merge' ? `${old.text}；${change.text}` : change.text;

        if (text.length > 800 || !text.trim()) {
          throw new Error('记忆内容过长或为空。');
        }
        const duplicate = this.db
          .prepare("SELECT id FROM memories WHERE scope=? AND subject_id=? AND normalized=? AND status='active'")
          .get(key, subjectId, normalize(text));

        if (duplicate) {
          continue;
        }
        const capacity = scope.channelId.startsWith('private:') ? 1980 : 2000;
        const count = this.db.prepare("SELECT count(*) AS n FROM memories WHERE scope=? AND origin<>'explicit' AND status='active'").get(key);
        const total = this.db.prepare("SELECT count(*) AS n FROM memories WHERE scope=? AND origin<>'explicit'").get(key);

        if (Number(total.n) >= 10000) {
          throw new Error('当前会话记忆及历史版本总容量已满，请先整理资料。');
        }
        if (!old && Number(count.n) >= capacity) {
          throw new Error('当前会话记忆容量已满。');
        }
        if (old) {
          this.db.prepare("UPDATE memories SET status='outdated' WHERE scope=? AND id=?").run(key, old.id);
        }
        this.insert(scope, {
          id: randomUUID().replaceAll('-', '').slice(0, 12),
          subjectId,
          subjectName: refs[0].speaker,
          kind: change.kind,
          text,
          tags: change.tags,
          importance: change.importance,
          confidence: change.confidence,
          status: 'active',
          origin: 'extracted',
          sourceRefs: change.action === 'merge' ? [...old.sourceRefs, ...refs].slice(-20) : refs,
          supersedes: old ? [old.id] : [],
          createdAt: this.now(),
          updatedAt: this.now(),
          lastRecalledAt: 0,
          recallDays: 0
        });
        added++;
      }
      this.db
        .prepare('UPDATE memory_scopes SET checkpoint=?,last_run=?,retry_after=? WHERE scope=?')
        .run(Math.max(state.checkpoint, checkpoint), hasMore ? state.lastRun : this.now(), hasMore ? this.now() + 300000 : 0, key);

      return { applied: true, added };
    });
  }

  failed(scope: MemoryScope, guard: MemoryGuard): void {
    this.db
      .prepare('UPDATE memory_scopes SET retry_after=? WHERE scope=? AND epoch=? AND revision=? AND (?=-1 OR checkpoint=?)')
      .run(this.now() + 1800000, scopeKey(scope), guard.epoch, guard.revision, guard.checkpoint ?? -1, guard.checkpoint ?? -1);
  }

  forget(scope: MemoryScope, id: string, skipThrough: number): boolean {
    return this.transaction(() => {
      const key = scopeKey(scope);
      const all = this.list(scope, { limit: 10020 });
      const target = all.find(item => item.id === id);

      if (!target) {
        return false;
      }
      const removed = connectedMemoryIds(all, target, true);

      for (const entryId of removed) {
        this.db.prepare('DELETE FROM memories WHERE scope=? AND id=?').run(key, entryId);
      }
      this.db.prepare('DELETE FROM memory_recalls WHERE scope=?').run(key);
      this.db.prepare('UPDATE memory_scopes SET revision=revision+1,checkpoint=max(checkpoint,?) WHERE scope=?').run(skipThrough, key);

      return true;
    });
  }

  clear(scope: MemoryScope, skipThrough: number): void {
    this.observe(scope);
    this.transaction(() => {
      const key = scopeKey(scope);

      this.db.prepare('DELETE FROM memories WHERE scope=?').run(key);
      this.db.prepare('DELETE FROM memory_recalls WHERE scope=?').run(key);
      this.db.prepare('UPDATE memory_scopes SET revision=revision+1,checkpoint=max(checkpoint,?) WHERE scope=?').run(skipThrough, key);
    });
  }

  restore(scope: MemoryScope, id: string): boolean {
    return this.transaction(() => {
      const key = scopeKey(scope);
      const all = this.list(scope, { limit: 10020 });
      const item = all.find(entry => entry.id === id && entry.status === 'outdated');

      if (!item) {
        return false;
      }
      const connected = connectedMemoryIds(all, item, false);
      const current = all.filter(entry => entry.status === 'active' && connected.has(entry.id));

      const capacity = scope.channelId.startsWith('private:') ? 1980 : 2000;
      const active = this.db.prepare("SELECT count(*) AS n FROM memories WHERE scope=? AND origin<>'explicit' AND status='active'").get(key);

      if (item.origin !== 'explicit' && !current.length && Number(active.n) >= capacity) {
        throw new Error('有效记忆容量已满，无法恢复额外条目。');
      }
      for (const entry of current) {
        this.db.prepare("UPDATE memories SET status='outdated' WHERE scope=? AND id=?").run(key, entry.id);
      }
      this.db.prepare("UPDATE memories SET status='active',updated_at=? WHERE scope=? AND id=?").run(this.now(), key, id);
      this.db.prepare('UPDATE memory_scopes SET revision=revision+1 WHERE scope=?').run(key);

      return true;
    });
  }

  purgeHash(groupHash: string): void {
    this.db.prepare('DELETE FROM memory_scopes WHERE group_hash=?').run(groupHash);
  }

  cleanup(days = 30): void {
    this.db.prepare('DELETE FROM memory_scopes WHERE active_at<?').run(this.now() - days * 86400000);
  }
}

const processState = globalThis as typeof globalThis & { __agentLinkMemories__?: Map<string, MemoryStore> };
const stores = (processState.__agentLinkMemories__ ??= new Map<string, MemoryStore>());

export { normalize as memoryTextKey };

export const getMemoryStore = (config: DSHBridgeConfig): MemoryStore => {
  const path = join(config.workspaceRoot ? dirname(config.workspaceRoot) : dirname(config.dshHomeRoot), 'memories.sqlite');
  let store = stores.get(path);

  if (!store) {
    store = new MemoryStore(path);
    stores.set(path, store);
  }

  return store;
};
