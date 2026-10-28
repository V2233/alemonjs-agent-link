import { MediaError, type MediaConfig } from './config';
import { downloadAttachment, imageMime } from './download';
import { collectSticker } from './stickers';

export type StickerImportResult = { total: number; added: number; existing: number; failed: number };
const MAX_IMPORT = 30;
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

/**
 * Import already-curated QQ favorite image URLs. This only reads from the platform; it never writes
 * back to the user's QQ favorites. Every image still passes the normal format and manifest checks.
 */
export const importStickerUrls = async (
  config: MediaConfig,
  urls: string[],
  signal: AbortSignal,
  download = downloadAttachment
): Promise<StickerImportResult> => {
  if (!config.stickerRoot) throw new MediaError('尚未配置表情素材目录。');
  const selected = urls.slice(0, MAX_IMPORT);
  let added = 0;
  let existing = 0;
  let failed = 0;

  for (const url of selected) {
    signal.throwIfAborted();
    try {
      const data = await download(url, { ...config, maxBytes: Math.min(config.maxBytes, MAX_IMPORT_BYTES) }, signal);

      if (!imageMime(data)) {
        failed++;
        continue;
      }
      const result = await collectSticker(config, data, ['导入'], signal, { from: 'import' });

      if (result.existing) existing++;
      else added++;
    } catch {
      signal.throwIfAborted();
      failed++;
    }
  }

  return { total: selected.length, added, existing, failed };
};
