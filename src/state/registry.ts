import { createHash, randomUUID } from 'node:crypto';
import { getIoRedis } from '@alemonjs/db';
import type { Redis } from 'ioredis';
import type { AgentCapabilities, DSHBridgeConfig } from '@src/dsh/client';

const prefix = 'data:agent-link';
const recentTtlSeconds = 15 * 60;
const minimumDedupeTtlSeconds = 15 * 60;
const dedupeDeliveryMarginMs = 60_000;

/** Cover a full group queue, its own model turn, and final QQ delivery. */
export const getDedupeTtlSeconds = (config: Pick<DSHBridgeConfig, 'maxQueuedPerGroup' | 'requestTimeoutMs'>): number =>
  Math.max(minimumDedupeTtlSeconds, Math.ceil(((config.maxQueuedPerGroup + 1) * config.requestTimeoutMs + dedupeDeliveryMarginMs) / 1000));

const finalizeDedupeScript = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
return 1
`;

const releaseDedupeScript = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[1])
`;

const beginResetScript = `
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

const completeResetScript = `
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

const beginPurgeScript = `
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
  constructor(message = 'Redis 不可用') {
    super(message);
    this.name = 'RegistryUnavailableError';
  }
}

const redis = async (config: DSHBridgeConfig): Promise<Redis> => {
  const client = getIoRedis({ connectTimeout: Math.min(config.requestTimeoutMs, 5000) });

  try {
    await Promise.race([
      client.ping(),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('timeout')), Math.min(config.requestTimeoutMs, 5000)))
    ]);

    return client;
  } catch {
    throw new RegistryUnavailableError();
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

export class SessionRegistry {
  constructor(private readonly config: DSHBridgeConfig) {}
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
  async touch(channelId: string): Promise<GroupMeta> {
    const store = await redis(this.config);
    const meta = await this.meta(channelId);

    meta.lastActivity = Date.now();
    await store
      .multi()
      .set(key(channelId, 'meta.v1.json'), JSON.stringify(meta))
      .zadd(`${prefix}:retention.v1`, meta.lastActivity, groupHash(channelId))
      .exec();

    return meta;
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
    const meta = await this.touch(channelId);

    meta.policy = policy;
    await (await redis(this.config)).set(key(channelId, 'meta.v1.json'), JSON.stringify(meta));
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
  async clearRecent(channelId: string): Promise<void> {
    await (await redis(this.config)).del(key(channelId, 'recent.v1.jsonl'));
  }
  async purge(channelId: string): Promise<void> {
    const store = await redis(this.config);

    await store.del(key(channelId, 'meta.v1.json'), key(channelId, 'recent.v1.jsonl'));
    await store.zrem(`${prefix}:retention.v1`, groupHash(channelId));
  }
  async expiredGroups(): Promise<string[]> {
    return await (await redis(this.config)).zrangebyscore(`${prefix}:retention.v1`, 0, Date.now() - this.config.retentionDays * 86400_000, 'LIMIT', 0, 100);
  }
  async purgeHash(hash: string): Promise<void> {
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
