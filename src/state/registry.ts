import { createHash, randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { getLocalStore } from './local-store';
import { getChatArchive } from '../history/store';
import { join, dirname } from 'node:path';
import type { AgentCapabilities, DSHBridgeConfig } from '@src/dsh/client';

const prefix = 'data:agent-link';
const recentTtlSeconds = 15 * 60;
const minimumDedupeTtlSeconds = 15 * 60;
const dedupeDeliveryMarginMs = 60_000;
const maximumMediaPreparationMs = 120_000;

/** Cover a full queue including bounded media preparation, model turns, and final QQ delivery. */
export const getDedupeTtlSeconds = (config: Pick<DSHBridgeConfig, 'maxQueuedPerGroup' | 'requestTimeoutMs'>): number =>
  Math.max(
    minimumDedupeTtlSeconds,
    Math.ceil(((config.maxQueuedPerGroup + 1) * (config.requestTimeoutMs + maximumMediaPreparationMs) + dedupeDeliveryMarginMs) / 1000)
  );

const finalizeDedupeScript = `-- agent-link:finalizeDedupe
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
return 1
`;

const releaseDedupeScript = `-- agent-link:releaseDedupe
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[1])
`;

const touchScript = `-- agent-link:touch
local raw = redis.call('GET', KEYS[1])
local meta = raw and cjson.decode(raw) or cjson.decode(ARGV[3])
if ARGV[4] ~= '' and (not raw or meta.generation ~= tonumber(ARGV[4]) or meta.isolated ~= true or (meta.transition and meta.transition ~= cjson.null)) then
  return cjson.encode(meta)
end
meta.lastActivity = tonumber(ARGV[1])
redis.call('SET', KEYS[1], cjson.encode(meta))
redis.call('ZADD', KEYS[2], meta.lastActivity, ARGV[2])
return cjson.encode(meta)
`;
const setPolicyScript = `-- agent-link:setPolicy
local raw = redis.call('GET', KEYS[1])
local meta = raw and cjson.decode(raw) or cjson.decode(ARGV[2])
meta.policy = cjson.decode(ARGV[1])
redis.call('SET', KEYS[1], cjson.encode(meta))
`;

const beginResetScript = `-- agent-link:beginReset
local raw = redis.call('GET', KEYS[1])
local meta = {}
if raw then
  local ok, decoded = pcall(cjson.decode, raw)
  if ok and type(decoded) == 'table' then meta = decoded end
end
if meta.transition == 'resetting' and type(meta.operationId) == 'string' then
  return cjson.encode(meta)
end
meta.generation = (tonumber(meta.generation) or 0) + 1
if type(meta.policy) ~= 'table' or meta.policy.version ~= 1 then
  meta.policy = { version = 1, chat = true, web = true, files = false, terminal = false }
end
meta.lastActivity = tonumber(ARGV[1])
meta.isolated = false
meta.transition = 'resetting'
meta.operationId = ARGV[2]
redis.call('SET', KEYS[1], cjson.encode(meta))
redis.call('ZADD', KEYS[2], meta.lastActivity, ARGV[3])
return cjson.encode(meta)
`;

const completeResetScript = `-- agent-link:completeReset
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local ok, meta = pcall(cjson.decode, raw)
if not ok or type(meta) ~= 'table' then return 0 end
if meta.transition ~= 'resetting' or meta.operationId ~= ARGV[1] then return 0 end
meta.isolated = true
meta.transition = cjson.null
meta.operationId = cjson.null
redis.call('SET', KEYS[1], cjson.encode(meta))
return 1
`;

const beginPurgeScript = `-- agent-link:beginPurge
local raw = redis.call('GET', KEYS[1])
local meta = {}
if raw then
  local ok, decoded = pcall(cjson.decode, raw)
  if ok and type(decoded) == 'table' then meta = decoded end
end
if meta.transition == 'purging' and type(meta.operationId) == 'string' then
  return cjson.encode(meta)
end
if type(meta.policy) ~= 'table' or meta.policy.version ~= 1 then
  meta.policy = { version = 1, chat = true, web = true, files = false, terminal = false }
end
meta.lastActivity = tonumber(ARGV[1])
meta.isolated = false
meta.transition = 'purging'
meta.operationId = ARGV[2]
redis.call('SET', KEYS[1], cjson.encode(meta))
redis.call('ZADD', KEYS[2], meta.lastActivity, ARGV[3])
return cjson.encode(meta)
`;

export type GroupPolicy = AgentCapabilities & { version: 1 };
export const defaultGroupPolicy: GroupPolicy = { version: 1, chat: true, web: true, files: false, terminal: false };
export const publicPrivatePolicy: GroupPolicy = { version: 1, chat: true, web: false, files: false, terminal: false };
export const ownerPrivatePolicy: GroupPolicy = { version: 1, chat: true, web: true, files: true, terminal: true };
export type RecentMessage = { id?: string; text: string; timestamp: number };
export type GroupTransition = 'resetting' | 'purging';
export type GroupMeta = {
  generation: number;
  policy: GroupPolicy;
  lastActivity: number;
  isolated: boolean;
  transition?: GroupTransition;
  operationId?: string;
};

const groupHash = (channelId: string): string => createHash('sha256').update(channelId).digest('hex');
const key = (channelId: string, name: string): string => `${prefix}:group:${groupHash(channelId)}:${name}`;

export class RegistryUnavailableError extends Error {
  constructor(message = '会话状态库不可用') {
    super(message);
    this.name = 'RegistryUnavailableError';
  }
}

const redis = async (config: DSHBridgeConfig): Promise<Redis> => {
  if (config.stateBackend === 'local') {
    return (await getLocalStore(join(dirname(config.dshHomeRoot), 'state.json'))) as unknown as Redis;
  }
  const { getIoRedis } = await import('@alemonjs/db');
  const client = getIoRedis({ connectTimeout: Math.min(config.requestTimeoutMs, 5000) });

  let healthTimeout: ReturnType<typeof setTimeout>;

  try {
    await Promise.race([
      client.ping(),
      new Promise<never>((_resolve, reject) => {
        healthTimeout = setTimeout(() => reject(new Error('timeout')), Math.min(config.requestTimeoutMs, 5000));
      })
    ]);

    return client;
  } catch {
    throw new RegistryUnavailableError();
  } finally {
    clearTimeout(healthTimeout);
  }
};

const parseMeta = (value: string | null): GroupMeta => {
  if (!value) {
    return { generation: 0, policy: defaultGroupPolicy, lastActivity: Date.now(), isolated: false };
  }
  try {
    const raw = JSON.parse(value) as Partial<GroupMeta>;

    return {
      generation: Number.isInteger(raw.generation) ? raw.generation : 0,
      // Legacy chat-only records upgrade to the new public default.
      policy:
        raw.policy && typeof raw.policy === 'object' && (raw.policy as Partial<GroupPolicy>).version === 1
          ? {
              version: 1,
              chat: (raw.policy as Partial<GroupPolicy>).chat === true,
              web: (raw.policy as Partial<GroupPolicy>).web === true,
              files: (raw.policy as Partial<GroupPolicy>).files === true,
              terminal: (raw.policy as Partial<GroupPolicy>).terminal === true
            }
          : defaultGroupPolicy,
      lastActivity: typeof raw.lastActivity === 'number' ? raw.lastActivity : Date.now(),
      // Existing pre-isolation metadata must never authorize reuse of an old home.
      isolated: raw.isolated === true,
      transition: raw.transition === 'resetting' || raw.transition === 'purging' ? raw.transition : undefined,
      operationId: typeof raw.operationId === 'string' ? raw.operationId : undefined
    };
  } catch {
    return { generation: 0, policy: defaultGroupPolicy, lastActivity: Date.now(), isolated: false };
  }
};

export type PrivateHistoryContext = {
  channelId: string;
  generation: number;
  memoryContext?: string;
  record?: () => boolean;
  render?: (text: string) => string;
};
export type ChatHistoryMessage = { role: 'user' | 'assistant'; content: string };
const appendPrivateTurnScript = `-- agent-link:appendPrivateTurn
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local meta = cjson.decode(raw)
if meta.generation ~= tonumber(ARGV[1]) or meta.isolated ~= true or (meta.transition and meta.transition ~= cjson.null) then return 0 end
redis.call('RPUSH', KEYS[2], ARGV[2])
redis.call('LTRIM', KEYS[2], -tonumber(ARGV[3]), -1)
redis.call('EXPIRE', KEYS[2], ARGV[4])
return 1
`;

export type PrivateMemory = { id: string; text: string; createdAt: number };
export const privateMemoryLimit = 20;
export const privateMemoryTextLimit = 200;
const memoryScript = `-- agent-link:memory
local raw = redis.call('GET', KEYS[1])
local notes = raw and cjson.decode(raw) or {}
local action = ARGV[1]
if action == 'add' then
  for _, note in ipairs(notes) do
    if note.text == ARGV[2] then return cjson.encode({status='exists', notes=notes}) end
  end
  if #notes >= tonumber(ARGV[5]) then return cjson.encode({status='full', notes=notes}) end
  table.insert(notes, {id=ARGV[3], text=ARGV[2], createdAt=tonumber(ARGV[4])})
elseif action == 'remove' then
  local found = false
  for i=#notes,1,-1 do
    if notes[i].id == ARGV[2] then table.remove(notes,i); found = true end
  end
  if not found then return cjson.encode({status='missing', notes=notes}) end
elseif action == 'clear' then
  redis.call('DEL', KEYS[1])
  return cjson.encode({status='ok', notes={}})
end
if #notes > 0 then
  redis.call('SET', KEYS[1], cjson.encode(notes), 'EX', ARGV[6])
else
  redis.call('DEL', KEYS[1])
end
return cjson.encode({status='ok', notes=notes})
`;

export class SessionRegistry {
  constructor(private readonly config: DSHBridgeConfig) {}
  async claimSticker(channelId: string, seconds: number): Promise<boolean> {
    if (seconds === 0) {
      return true;
    }

    return Boolean(await (await redis(this.config)).set(key(channelId, 'sticker-cooldown'), '1', 'EX', seconds, 'NX'));
  }
  async privateMemories(channelId: string): Promise<PrivateMemory[]> {
    return (await this.changePrivateMemory(channelId, 'list')).notes;
  }
  async changePrivateMemory(channelId: string, action: 'list' | 'add' | 'remove' | 'clear', text = ''): Promise<{ status: string; notes: PrivateMemory[] }> {
    if (!channelId.startsWith('private:')) {
      throw new Error('长期记忆仅限私聊。');
    }
    if (action === 'add' && (!text.trim() || Array.from(text.trim()).length > privateMemoryTextLimit)) {
      throw new Error(`每条记忆需要 1–${privateMemoryTextLimit} 个字符。`);
    }
    const raw = await (
      await redis(this.config)
    ).eval(
      memoryScript,
      1,
      key(channelId, 'private-memory.v1.json'),
      action,
      text.trim(),
      randomUUID().slice(0, 8),
      String(Date.now()),
      String(privateMemoryLimit),
      String(this.config.retentionDays * 86400)
    );
    const result = JSON.parse(String(raw));

    return { status: result.status, notes: Array.isArray(result.notes) ? result.notes : [] };
  }
  async privateHistory(context: PrivateHistoryContext): Promise<ChatHistoryMessage[]> {
    if (!this.config.privateHistoryMaxTurns) {
      return [];
    }
    const rows = await (await redis(this.config)).lrange(key(context.channelId, 'private-history.v1'), -this.config.privateHistoryMaxTurns, -1);
    const result: ChatHistoryMessage[] = [];
    let chars = 0;

    for (const row of rows.toReversed()) {
      try {
        const turn = JSON.parse(row);

        if (
          turn.generation !== context.generation ||
          turn.timestamp < Date.now() - this.config.privateHistoryTtlSeconds * 1000 ||
          typeof turn.user !== 'string' ||
          typeof turn.assistant !== 'string'
        ) {
          continue;
        }
        chars += turn.user.length + turn.assistant.length;
        if (chars > this.config.privateHistoryMaxChars) {
          break;
        }
        result.unshift({ role: 'user', content: turn.user }, { role: 'assistant', content: turn.assistant });
      } catch {
        continue;
      }
    }

    return result;
  }
  async appendPrivateTurn(context: PrivateHistoryContext, user: string, assistant: string): Promise<void> {
    if (!this.config.privateHistoryMaxTurns || context.record?.() === false) {
      return;
    }
    assistant = context.render ? context.render(assistant) : assistant;
    // Preserve complete role pairs; oversized turns are omitted instead of retaining partial instructions.
    if (user.length + assistant.length > this.config.privateHistoryMaxChars) {
      return;
    }
    await (
      await redis(this.config)
    ).eval(
      appendPrivateTurnScript,
      2,
      key(context.channelId, 'meta.v1.json'),
      key(context.channelId, 'private-history.v1'),
      String(context.generation),
      JSON.stringify({ generation: context.generation, timestamp: Date.now(), user, assistant }),
      String(this.config.privateHistoryMaxTurns),
      String(this.config.privateHistoryTtlSeconds)
    );
  }
  async ready(): Promise<void> {
    await redis(this.config);
  }
  async health(): Promise<boolean> {
    try {
      await redis(this.config);

      return true;
    } catch {
      return false;
    }
  }
  async groupKey(channelId: string): Promise<string> {
    return await Promise.resolve(groupHash(channelId));
  }
  async meta(channelId: string): Promise<GroupMeta> {
    return parseMeta(await (await redis(this.config)).get(key(channelId, 'meta.v1.json')));
  }
  async touch(channelId: string, expectedGeneration?: number): Promise<GroupMeta> {
    const raw = await (
      await redis(this.config)
    ).eval(
      touchScript,
      2,
      key(channelId, 'meta.v1.json'),
      `${prefix}:retention.v1`,
      String(Date.now()),
      groupHash(channelId),
      JSON.stringify(parseMeta(null)),
      expectedGeneration === undefined ? '' : String(expectedGeneration)
    );

    return parseMeta(String(raw));
  }
  async beginReset(channelId: string): Promise<GroupMeta> {
    const timestamp = Date.now();
    const raw = await (
      await redis(this.config)
    ).eval(beginResetScript, 2, key(channelId, 'meta.v1.json'), `${prefix}:retention.v1`, String(timestamp), randomUUID(), groupHash(channelId));

    return parseMeta(String(raw));
  }
  async completeReset(channelId: string, operationId: string): Promise<boolean> {
    return Number(await (await redis(this.config)).eval(completeResetScript, 1, key(channelId, 'meta.v1.json'), operationId)) === 1;
  }
  async beginPurge(channelId: string): Promise<GroupMeta> {
    const timestamp = Date.now();
    const raw = await (
      await redis(this.config)
    ).eval(beginPurgeScript, 2, key(channelId, 'meta.v1.json'), `${prefix}:retention.v1`, String(timestamp), randomUUID(), groupHash(channelId));

    return parseMeta(String(raw));
  }
  async policy(channelId: string): Promise<GroupPolicy> {
    return (await this.meta(channelId)).policy;
  }
  async setPolicy(channelId: string, policy: GroupPolicy): Promise<void> {
    await this.touch(channelId);
    await (await redis(this.config)).eval(setPolicyScript, 1, key(channelId, 'meta.v1.json'), JSON.stringify(policy), JSON.stringify(parseMeta(null)));
  }
  async deduplicate(channelId: string, messageId?: string): Promise<{ duplicate: boolean; requestId: string }> {
    const requestId = randomUUID();

    if (!messageId) {
      return { duplicate: false, requestId };
    }
    const accepted = await (
      await redis(this.config)
    ).set(this.dedupeKey(channelId, messageId), `running:${requestId}`, 'EX', getDedupeTtlSeconds(this.config), 'NX');

    return { duplicate: !accepted, requestId };
  }
  async finalizeDeduplication(channelId: string, messageId: string | undefined, requestId: string): Promise<boolean> {
    if (!messageId) {
      return true;
    }

    return (
      Number(
        await (
          await redis(this.config)
        ).eval(
          finalizeDedupeScript,
          1,
          this.dedupeKey(channelId, messageId),
          `running:${requestId}`,
          `delivered:${requestId}`,
          String(getDedupeTtlSeconds(this.config))
        )
      ) === 1
    );
  }
  async releaseDeduplication(channelId: string, messageId: string | undefined, requestId: string): Promise<void> {
    if (!messageId) {
      return;
    }
    await (await redis(this.config)).eval(releaseDedupeScript, 1, this.dedupeKey(channelId, messageId), `running:${requestId}`);
  }
  async allowUser(channelId: string, userId: string): Promise<boolean> {
    const store = await redis(this.config);
    const now = Date.now();
    const rateKey = `${prefix}:rate:${groupHash(channelId)}:${createHash('sha256').update(userId).digest('hex')}`;
    const result = await store
      .multi()
      .zremrangebyscore(rateKey, 0, now - 60_000)
      .zadd(rateKey, now, randomUUID())
      .zcard(rateKey)
      .expire(rateKey, 61)
      .exec();

    return Number(result?.[2]?.[1] ?? 0) <= this.config.maxCallsPerUserPerMinute;
  }
  async recordRecent(channelId: string, message: Omit<RecentMessage, 'timestamp'> & { timestamp?: number }): Promise<void> {
    const text = message.text.replace(/\s+/g, ' ').trim();

    if (!text || this.config.recentChatMaxMessages === 0) {
      return;
    }
    const store = await redis(this.config);
    const recentKey = key(channelId, 'recent.v1.jsonl');

    await store
      .multi()
      .rpush(recentKey, JSON.stringify({ id: message.id, text, timestamp: message.timestamp ?? Date.now() }))
      .ltrim(recentKey, -this.config.recentChatMaxMessages, -1)
      .expire(recentKey, Math.min(recentTtlSeconds, this.config.recentChatWindowSeconds))
      .exec();
  }
  async recent(channelId: string, excludedMessageId?: string): Promise<RecentMessage[]> {
    if (this.config.recentChatMaxMessages === 0 || this.config.recentChatMaxChars === 0) {
      return [];
    }
    const rows = await (await redis(this.config)).lrange(key(channelId, 'recent.v1.jsonl'), 0, -1);
    const cutoff = Date.now() - this.config.recentChatWindowSeconds * 1000;
    const parsed = rows.flatMap(row => {
      try {
        const value = JSON.parse(row) as RecentMessage;

        return typeof value.text === 'string' && value.timestamp >= cutoff && value.id !== excludedMessageId ? [value] : [];
      } catch {
        return [];
      }
    });
    let chars = 0;
    const output: RecentMessage[] = [];

    for (const item of parsed.toReversed()) {
      const remaining = this.config.recentChatMaxChars - chars;

      if (remaining <= 0) {
        break;
      }
      const text = item.text.slice(0, remaining);

      output.unshift({ ...item, text });
      chars += text.length;
    }

    return output;
  }
  async clearPrivateHistory(channelId: string): Promise<void> {
    await (await redis(this.config)).del(key(channelId, 'private-history.v1'));
  }
  async clearRecent(channelId: string): Promise<void> {
    await (await redis(this.config)).del(key(channelId, 'recent.v1.jsonl'));
  }
  async purge(channelId: string): Promise<void> {
    getChatArchive(this.config).purgeHash(groupHash(channelId));
    const store = await redis(this.config);

    await store.del(
      key(channelId, 'meta.v1.json'),
      key(channelId, 'recent.v1.jsonl'),
      key(channelId, 'private-history.v1'),
      key(channelId, 'private-memory.v1.json')
    );
    await store.zrem(`${prefix}:retention.v1`, groupHash(channelId));
  }
  async expiredGroups(): Promise<string[]> {
    return await (await redis(this.config)).zrangebyscore(`${prefix}:retention.v1`, 0, Date.now() - this.config.retentionDays * 86400_000, 'LIMIT', 0, 100);
  }
  async purgeHash(hash: string, includeArchive = true): Promise<void> {
    if (includeArchive) {
      getChatArchive(this.config).purgeHash(hash);
    }
    const store = await redis(this.config);
    let cursor = '0';

    do {
      const [next, keys] = await store.scan(cursor, 'MATCH', `${prefix}:group:${hash}:*`, 'COUNT', 100);

      cursor = next;
      if (keys.length) {
        await store.del(...keys);
      }
    } while (cursor !== '0');
    await store.zrem(`${prefix}:retention.v1`, hash);
  }
  private dedupeKey(channelId: string, messageId: string): string {
    return `${prefix}:dedupe:${groupHash(channelId)}:${messageId}`;
  }
}
