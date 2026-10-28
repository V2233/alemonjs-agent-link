import { logger, type MessageMediaItem } from 'alemonjs';
import type { DSHBridgeConfig } from '../dsh/config';
import { getDSHConfig } from '../dsh/runtime-config';
import { withBudgetScope } from '../billing/budget';
import { getMediaConfig, type MediaConfig } from './config';
import { downloadAttachment, imageMime } from './download';
import { collectSticker } from './stickers';
import { labelSticker } from './providers';
import { bindOnebotImageResolver } from './onebot-images';

type Event = {
  Platform?: string;
  ChannelId?: string;
  MessageId?: string;
  UserId?: string;
  IsPrivate?: boolean;
  IsMaster?: boolean;
  IsBot?: boolean;
  MessageMedia?: MessageMediaItem[];
};
type Settings = { enabled: boolean; ownerPrivate: boolean; groups: string[]; label: boolean; maxPerHour: number };
export const autoStickerSettings = (config: DSHBridgeConfig): Settings => {
  const raw = config.modules?.settings?.stickers || {};
  const { autoCollect = false, autoOwnerPrivate = false, autoGroups = [], autoLabel = false, autoMaxPerHour = 20 } = raw;

  if (
    typeof autoCollect !== 'boolean' ||
    typeof autoOwnerPrivate !== 'boolean' ||
    typeof autoLabel !== 'boolean' ||
    !Array.isArray(autoGroups) ||
    autoGroups.length > 100 ||
    autoGroups.some(value => typeof value !== 'string' || value.length < 3 || value.length > 200 || !value.includes(':')) ||
    !Number.isSafeInteger(autoMaxPerHour) ||
    Number(autoMaxPerHour) < 1 ||
    Number(autoMaxPerHour) > 100
  ) {
    throw new Error('表情自动收集设置无效。');
  }

  return {
    enabled: autoCollect && !config.modules?.disabled?.includes('stickers') && config.aiEnabled !== false,
    ownerPrivate: autoOwnerPrivate,
    groups: autoGroups,
    label: autoLabel,
    maxPerHour: Number(autoMaxPerHour)
  };
};

type Dependencies = {
  config: () => DSHBridgeConfig;
  media: () => MediaConfig;
  download: typeof downloadAttachment;
  label: typeof labelSticker;
  collect: typeof collectSticker;
  failed: () => void;
};
type Job = {
  platform: string;
  channelId: string;
  userId: string;
  item: MessageMediaItem;
  index: number;
  lookup?: ReturnType<typeof bindOnebotImageResolver>;
  label: boolean;
  generation: number;
};
export class AutoStickerCollector {
  private readonly queue: Job[] = [];
  private readonly seen = new Map<string, number>();
  private attempts: number[] = [];
  private running = false;
  private generation = 0;
  private active?: AbortController;
  constructor(private readonly deps: Dependencies) {}

  enqueue(event: Event): number {
    const settings = autoStickerSettings(this.deps.config());
    const platform = event.Platform || '';
    const userId = event.UserId || '';
    const channelId = event.IsPrivate ? `private:${JSON.stringify([platform, userId])}` : event.ChannelId || '';

    if (
      !settings.enabled ||
      event.IsBot ||
      !platform ||
      !userId ||
      !channelId ||
      !event.MessageId ||
      (event.IsPrivate ? !(settings.ownerPrivate && event.IsMaster) : !settings.groups.includes(`${platform}:${channelId}`))
    )
      return 0;
    const items = (event.MessageMedia || [])
      .map((item, index) => ({ item, index }))
      .filter(
        ({ item, index }) =>
          item.Type === 'sticker' &&
          (Boolean(item.Url) || (platform === 'onebot' && index < 5 && Boolean((item as MessageMediaItem & { _onebotImageFile?: string })._onebotImageFile)))
      )
      .slice(0, 3);
    const lookup = items.some(
      ({ item, index }) => platform === 'onebot' && index < 5 && Boolean((item as MessageMediaItem & { _onebotImageFile?: string })._onebotImageFile)
    )
      ? bindOnebotImageResolver(event)
      : undefined;
    const now = Date.now();

    this.attempts = this.attempts.filter(at => now - at < 3600_000);
    for (const [key, at] of this.seen) if (now - at >= 3600_000) this.seen.delete(key);
    let accepted = 0;

    for (const { item, index } of items) {
      const key = JSON.stringify([platform, channelId, event.MessageId, index]);

      if (this.seen.has(key) || this.queue.length >= 8 || this.attempts.length >= settings.maxPerHour) continue;
      this.seen.set(key, now);
      this.attempts.push(now);
      this.queue.push({ platform, channelId, userId, item: { ...item }, index, lookup, label: settings.label, generation: this.generation });
      accepted++;
    }
    if (accepted && !this.running) void this.drain();

    return accepted;
  }

  reset(): void {
    this.generation++;
    this.queue.length = 0;
    this.active?.abort();
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const job = this.queue.shift();
        const controller = new AbortController();

        this.active = controller;
        try {
          const current = autoStickerSettings(this.deps.config());

          if (
            !current.enabled ||
            job.generation !== this.generation ||
            (job.channelId.startsWith('private:') ? !current.ownerPrivate : !current.groups.includes(`${job.platform}:${job.channelId}`))
          )
            continue;
          const media = this.deps.media();

          if (!media.stickerRoot || (job.item.FileSize && job.item.FileSize > media.maxBytes)) continue;
          const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(media.timeoutMs)]);
          let data: Buffer | undefined;

          if (job.item.Url) {
            try {
              const candidate = await this.deps.download(job.item.Url, media, signal);

              if (candidate.length <= media.maxBytes && imageMime(candidate)) data = candidate;
            } catch {
              signal.throwIfAborted();
            }
          }
          if (!data && job.lookup) {
            const value = await job.lookup(job.index);

            signal.throwIfAborted();
            if (
              value?.base64 &&
              value.base64.length <= Math.ceil((media.maxBytes * 4) / 3) + 4 &&
              /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value.base64)
            ) {
              const candidate = Buffer.from(value.base64, 'base64');

              if (candidate.length <= media.maxBytes && imageMime(candidate)) data = candidate;
            } else if (value?.url) data = await this.deps.download(value.url, media, signal);
          }
          if (!data || data.length > media.maxBytes || !imageMime(data)) throw new Error('表情图片不可用。');
          let tags: string[] = [];

          if (job.label && current.label && media.vision) {
            try {
              tags = await withBudgetScope({ platform: job.platform, channelId: job.channelId, userId: job.userId }, () =>
                this.deps.label(data, media, signal)
              );
            } catch {
              signal.throwIfAborted();
            }
          }
          signal.throwIfAborted();
          if (job.generation !== this.generation) continue;
          await this.deps.collect(media, data, tags.length ? tags : ['表情'], signal);
        } catch {
          if (!controller.signal.aborted) this.deps.failed();
        } finally {
          if (this.active === controller) this.active = undefined;
        }
      }
    } finally {
      this.running = false;
    }
  }
}

export const autoStickerCollector = new AutoStickerCollector({
  config: getDSHConfig,
  media: getMediaConfig,
  download: downloadAttachment,
  label: labelSticker,
  collect: collectSticker,
  failed: () => logger.warn('Automatic sticker collection failed')
});
