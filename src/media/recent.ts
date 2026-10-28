import type { MessageMediaItem } from 'alemonjs';
import { getMediaConfig } from './config';
import { downloadAttachment, imageMime } from './download';
import { bindOnebotImageResolver } from './onebot-images';

type RecentEvent = {
  Platform?: string;
  ChannelId?: string;
  UserId?: string;
  MessageId?: string;
  IsPrivate?: boolean;
  IsMaster?: boolean;
  IsBot?: boolean;
  MessageMedia?: MessageMediaItem[];
};
type Entry = { at: number; userId: string; item: MessageMediaItem; index: number; event: RecentEvent };
const TTL = 30 * 60_000;
const MAX_ENTRIES = 6;
const MAX_BYTES = 5 * 1024 * 1024;
const store = new Map<string, Entry[]>();
const keyOf = (platform: string, channelId: string): string => `${platform}:${channelId}`;
const conversationOf = (event: RecentEvent): string =>
  event.IsPrivate ? (event.Platform && event.UserId ? `private:${JSON.stringify([event.Platform, event.UserId])}` : '') : event.ChannelId || '';

/**
 * Keep a small in-memory window of recent image attachments so "把刚才那张做成表情" works
 * without quoting. Only metadata/URLs are retained; bytes are downloaded on demand.
 */
export const rememberRecentMedia = (event: RecentEvent): void => {
  const platform = event.Platform || '';
  const channelId = conversationOf(event);

  if (event.IsBot || !platform || !channelId || !event.MessageId) return;
  const candidates = (event.MessageMedia || [])
    .map((item, index) => ({ item, index }))
    .filter(
      ({ item, index }) =>
        ['image', 'sticker', 'animation'].includes(item.Type) &&
        (Boolean(item.Url) || (platform === 'onebot' && index < 5 && Boolean((item as MessageMediaItem & { _onebotImageFile?: string })._onebotImageFile)))
    );

  if (!candidates.length) return;
  const now = Date.now();
  const key = keyOf(platform, channelId);
  const list = (store.get(key) || []).filter(entry => now - entry.at < TTL);

  for (const { item, index } of candidates.slice(0, 3)) {
    list.push({ at: now, userId: event.UserId || '', item: { ...item }, index, event: { ...event } });
  }
  store.set(key, list.slice(-MAX_ENTRIES));

  // Bound the number of conversations retained by a long-running process.
  while (store.size > 500) {
    let removed = false;

    for (const candidate of store.keys()) {
      if (candidate === key) continue;
      store.delete(candidate);
      removed = true;
      break;
    }
    if (!removed) break;
  }
};

export const clearRecentMedia = (): void => {
  store.clear();
};

/** Resolve the most recent image in a conversation, preferring the caller's own uploads. */
export const takeRecentImage = async (
  platform: string,
  channelId: string,
  signal: AbortSignal,
  userId?: string,
  download = downloadAttachment
): Promise<Buffer | undefined> => {
  const now = Date.now();
  const entries = (store.get(keyOf(platform, channelId)) || []).filter(entry => now - entry.at < TTL);

  if (!entries.length) return undefined;
  if (entries.length !== (store.get(keyOf(platform, channelId)) || []).length) store.set(keyOf(platform, channelId), entries);
  const entry = [...entries].reverse().find(item => userId && item.userId === userId) || entries[entries.length - 1];

  if (!entry) return undefined;
  const config = getMediaConfig();
  const maxBytes = Math.min(config.maxBytes, MAX_BYTES);

  if (entry.item.Url) {
    try {
      const data = await download(entry.item.Url, { ...config, maxBytes }, signal);

      if (data.length <= maxBytes && imageMime(data)) return data;
    } catch {
      signal.throwIfAborted();
    }
  }
  const lookup = bindOnebotImageResolver(entry.event);

  if (lookup) {
    const value = await lookup(entry.index);

    signal.throwIfAborted();
    if (value?.base64 && value.base64.length <= Math.ceil((maxBytes * 4) / 3) + 4) {
      const data = Buffer.from(value.base64, 'base64');

      if (data.length <= maxBytes && imageMime(data)) return data;
    } else if (value?.url) {
      const data = await download(value.url, { ...config, maxBytes }, signal);

      if (data.length <= maxBytes && imageMime(data)) return data;
    }
  }

  return undefined;
};
