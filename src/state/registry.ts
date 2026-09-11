import { createHash, randomUUID } from 'node:crypto';
import { getIoRedis } from '@alemonjs/db';
import type { Redis } from 'ioredis';
import type { DSHBridgeConfig } from '@src/dsh/client';

const prefix = 'data:agent-link';
const recentTtlSeconds = 15 * 60;
const dedupeTtlSeconds = 15 * 60;

export type GroupPolicy = 'chat-only';
export type RecentMessage = { id?: string; text: string; timestamp: number };
type GroupMeta = { generation: number; policy: GroupPolicy; lastActivity: number; isolated: boolean };

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
    return { generation: 0, policy: 'chat-only', lastActivity: Date.now(), isolated: false };
  }
  try {
    const raw = JSON.parse(value) as Partial<GroupMeta>;

    return {
      generation: Number.isInteger(raw.generation) ? raw.generation : 0,
      policy: 'chat-only',
      lastActivity: typeof raw.lastActivity === 'number' ? raw.lastActivity : Date.now(),
      // Existing pre-isolation metadata must never authorize reuse of an old home.
      isolated: raw.isolated === true
    };
  } catch {
    return { generation: 0, policy: 'chat-only', lastActivity: Date.now(), isolated: false };
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
    return groupHash(channelId);
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
  async advance(channelId: string): Promise<GroupMeta> {
    const meta = await this.touch(channelId);

    meta.generation += 1;
    meta.isolated = true;
    await (await redis(this.config)).set(key(channelId, 'meta.v1.json'), JSON.stringify(meta));

    return meta;
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
    const requestId = createHash('sha256')
      .update(`${channelId}\0${messageId || randomUUID()}`)
      .digest('hex')
      .slice(0, 12);

    if (!messageId) {
      return { duplicate: false, requestId };
    }
    const accepted = await (await redis(this.config)).set(`${prefix}:dedupe:${groupHash(channelId)}:${messageId}`, requestId, 'EX', dedupeTtlSeconds, 'NX');

    return { duplicate: !accepted, requestId };
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
      if (keys.length) { await store.del(...keys); }
    } while (cursor !== '0');
    await store.zrem(`${prefix}:retention.v1`, hash);
  }
}
