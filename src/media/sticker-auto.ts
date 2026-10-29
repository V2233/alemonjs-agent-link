import { logger, type MessageMediaItem } from 'alemonjs';
import type { DSHBridgeConfig } from '../dsh/config';
import { getDSHConfig } from '../dsh/runtime-config';
import { withBudgetScope } from '../billing/budget';
import { getMediaConfig, type MediaConfig } from './config';
import { downloadAttachment, imageMime } from './download';
import { imageInfo } from './image-info';
import { collectSticker, setStickerEmoji } from './stickers';
import { assessSticker, type StickerAssessment } from './providers';
import { bindOnebotImageResolver } from './onebot-images';
import { addOnebotFavoriteSticker } from './onebot-favorites';

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
type Settings = {
  enabled: boolean;
  privateChats: boolean;
  groups: string[];
  allGroups: boolean;
  label: boolean;
  maxPerHour: number;
  detect: boolean;
  minConfidence: number;
  maxBytes: number;
  maxSide: number;
  qqSync: boolean;
};
export const autoStickerSettings = (config: DSHBridgeConfig): Settings => {
  const raw = config.modules?.settings?.stickers || {};
  const {
    autoCollect = true,
    autoPrivate = raw.autoOwnerPrivate ?? true,
    autoGroups = [],
    autoLabel = true,
    autoMaxPerHour = 60,
    autoDetect = true,
    autoMinConfidence = 0.6,
    autoMaxBytes = 2 * 1024 * 1024,
    autoMaxSide = 1024,
    autoAllGroups = Array.isArray(autoGroups) ? autoGroups.length === 0 : false,
    autoQQSync = true
  } = raw;

  if (
    typeof autoCollect !== 'boolean' ||
    typeof autoPrivate !== 'boolean' ||
    typeof autoLabel !== 'boolean' ||
    typeof autoDetect !== 'boolean' ||
    typeof autoAllGroups !== 'boolean' ||
    typeof autoQQSync !== 'boolean' ||
    !Array.isArray(autoGroups) ||
    autoGroups.length > 100 ||
    autoGroups.some(value => typeof value !== 'string' || value.length < 3 || value.length > 200 || !value.includes(':')) ||
    !Number.isSafeInteger(autoMaxPerHour) ||
    Number(autoMaxPerHour) < 1 ||
    Number(autoMaxPerHour) > 100 ||
    typeof autoMinConfidence !== 'number' ||
    !Number.isFinite(autoMinConfidence) ||
    autoMinConfidence < 0 ||
    autoMinConfidence > 1 ||
    !Number.isSafeInteger(autoMaxBytes) ||
    Number(autoMaxBytes) < 1024 ||
    Number(autoMaxBytes) > 25 * 1024 * 1024 ||
    !Number.isSafeInteger(autoMaxSide) ||
    Number(autoMaxSide) < 64 ||
    Number(autoMaxSide) > 2048
  ) {
    throw new Error('表情自动收集设置无效。');
  }

  return {
    enabled: autoCollect && !config.modules?.disabled?.includes('stickers') && config.aiEnabled !== false,
    privateChats: autoPrivate,
    groups: autoGroups,
    allGroups: autoAllGroups,
    label: autoLabel,
    maxPerHour: Number(autoMaxPerHour),
    detect: autoDetect,
    minConfidence: autoMinConfidence,
    maxBytes: Number(autoMaxBytes),
    maxSide: Number(autoMaxSide),
    qqSync: autoQQSync
  };
};

type Dependencies = {
  config: () => DSHBridgeConfig;
  media: () => MediaConfig;
  download: typeof downloadAttachment;
  assess: typeof assessSticker;
  collect: typeof collectSticker;
  favorite: typeof addOnebotFavoriteSticker;
  setEmoji: typeof setStickerEmoji;
  failed: () => void;
};
type Job = {
  platform: string;
  channelId: string;
  userId: string;
  event: Event;
  item: MessageMediaItem;
  index: number;
  lookup?: ReturnType<typeof bindOnebotImageResolver>;
  label: boolean;
  explicit: boolean;
  generation: number;
};
export class AutoStickerCollector {
  private readonly queue: Job[] = [];
  private readonly seen = new Map<string, number>();
  private attempts: { at: number; userKey: string }[] = [];
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
      (event.IsPrivate ? !settings.privateChats : !settings.allGroups && !settings.groups.includes(`${platform}:${channelId}`))
    )
      return 0;
    let vision = false;

    try {
      vision = Boolean(this.deps.media().vision);
    } catch {
      /* Media configuration can be temporarily invalid; explicit stickers still need no vision. */
    }
    const items = (event.MessageMedia || [])
      .map((item, index) => ({ item, index }))
      .filter(({ item, index }) => {
        if ((item as MessageMediaItem & { _onebotQuoted?: boolean })._onebotQuoted) return false;
        const resolvable =
          Boolean(item.Url) || (platform === 'onebot' && index < 5 && Boolean((item as MessageMediaItem & { _onebotImageFile?: string })._onebotImageFile));

        if (item.Type === 'sticker') return resolvable;

        return settings.detect && vision && ['image', 'animation'].includes(item.Type) && resolvable;
      })
      .slice(0, 3);
    const lookup = items.some(
      ({ item, index }) => platform === 'onebot' && index < 5 && Boolean((item as MessageMediaItem & { _onebotImageFile?: string })._onebotImageFile)
    )
      ? bindOnebotImageResolver(event)
      : undefined;
    const now = Date.now();

    this.attempts = this.attempts.filter(({ at }) => now - at < 3600_000);
    for (const [key, at] of this.seen) if (now - at >= 3600_000) this.seen.delete(key);
    const userKey = JSON.stringify([platform, userId]);
    let userAttempts = this.attempts.filter(attempt => attempt.userKey === userKey).length;
    let accepted = 0;

    for (const { item, index } of items) {
      const key = JSON.stringify([platform, channelId, event.MessageId, index]);

      if (this.seen.has(key) || this.queue.length >= 8 || this.attempts.length >= settings.maxPerHour || userAttempts >= 20) continue;
      this.seen.set(key, now);
      this.attempts.push({ at: now, userKey });
      userAttempts++;
      this.queue.push({
        platform,
        channelId,
        userId,
        event: { ...event },
        item: { ...item },
        index,
        lookup,
        label: settings.label,
        explicit: item.Type === 'sticker',
        generation: this.generation
      });
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
            (job.channelId.startsWith('private:') ? !current.privateChats : !current.allGroups && !current.groups.includes(`${job.platform}:${job.channelId}`))
          )
            continue;
          const media = this.deps.media();

          if (!media.stickerRoot) continue;
          if (!job.explicit && (!current.detect || !media.vision)) continue;
          const maxBytes = job.explicit ? media.maxBytes : current.maxBytes;

          if (job.item.FileSize && job.item.FileSize > maxBytes) continue;
          const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(media.timeoutMs)]);
          const downloadConfig = { ...media, maxBytes };
          let data: Buffer | undefined;

          if (job.item.Url) {
            try {
              const candidate = await this.deps.download(job.item.Url, downloadConfig, signal);

              if (candidate.length <= maxBytes && imageMime(candidate)) data = candidate;
            } catch {
              signal.throwIfAborted();
            }
          }
          if (!data && job.lookup) {
            const value = await job.lookup(job.index);

            signal.throwIfAborted();
            if (
              value?.base64 &&
              value.base64.length <= Math.ceil((maxBytes * 4) / 3) + 4 &&
              /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value.base64)
            ) {
              const candidate = Buffer.from(value.base64, 'base64');

              if (candidate.length <= maxBytes && imageMime(candidate)) data = candidate;
            } else if (value?.url) data = await this.deps.download(value.url, downloadConfig, signal);
          }
          if (!data || data.length > maxBytes || !imageMime(data)) throw new Error('表情图片不可用。');
          const info = imageInfo(data);

          if (!info && !job.explicit) continue;
          if (info) {
            const ratio = info.width / info.height;

            // Geometric prefilter only; the vision assessment makes the final sticker decision.
            if (info.width > current.maxSide || info.height > current.maxSide || ratio < 0.75 || ratio > 1.33) continue;
          }
          let assessment: StickerAssessment | undefined;

          if (media.vision && (current.detect || (job.explicit && current.label)) && imageMime(data) !== 'image/gif') {
            try {
              assessment = await withBudgetScope({ platform: job.platform, channelId: job.channelId, userId: job.userId }, () =>
                this.deps.assess(data, media, signal)
              );
            } catch {
              signal.throwIfAborted();
            }
          }
          if (!job.explicit) {
            if (!assessment || !assessment.suitable || assessment.confidence < current.minConfidence) continue;
          } else if (assessment && !assessment.suitable) continue;
          const kind = job.explicit
            ? assessment?.kind === 'avatar'
              ? 'avatar'
              : 'sticker'
            : (assessment?.kind ?? (assessment?.sticker ? 'sticker' : 'other'));
          const category = assessment?.category || (kind === 'avatar' ? '头像' : '未分类');
          const tags = assessment?.tags.length ? assessment.tags : [kind === 'avatar' ? '头像' : '表情'];

          if (!job.explicit && kind === 'other') continue;
          signal.throwIfAborted();
          if (job.generation !== this.generation) continue;
          const collected = await this.deps.collect(media, data, tags, signal, {
            from: 'auto',
            kind,
            category,
            ...(assessment?.name ? { name: assessment.name } : {}),
            ...(assessment ? { confidence: assessment.confidence } : {}),
            ...(info ? { width: info.width, height: info.height } : {})
          });

          if (current.qqSync && !collected.existing && this.deps.favorite && this.deps.setEmoji) {
            const emojiId = await this.deps.favorite(job.event, data, assessment?.name).catch(() => undefined);

            if (emojiId) await this.deps.setEmoji(media, collected.id, emojiId, signal).catch(() => undefined);
          }
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
  assess: assessSticker,
  collect: collectSticker,
  favorite: addOnebotFavoriteSticker,
  setEmoji: setStickerEmoji,
  failed: () => logger.warn('Automatic sticker collection failed')
});
