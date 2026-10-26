import { open, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { MediaError, MediaUnavailableError, type MediaConfig } from './config';
import { imageMime } from './download';

export type Sticker = { id: string; file: string; tags: string[] };
const readLocal = async (root: string, path: string, maxBytes: number): Promise<Buffer> => {
  const base = await realpath(root);
  const candidate = await realpath(resolve(base, path));

  if (!candidate.startsWith(`${base}${sep}`)) {
    throw new MediaError('表情文件必须位于素材目录内。');
  }
  const file = await open(candidate, 'r');

  try {
    const info = await file.stat();

    if (!info.isFile() || info.size > maxBytes) {
      throw new MediaError('表情文件超过限制或不是普通文件。');
    }
    const data = Buffer.alloc(maxBytes + 1);
    const result = await file.read(data, 0, data.length, 0);

    if (result.bytesRead > maxBytes) {
      throw new MediaError('表情文件超过限制。');
    }

    return data.subarray(0, result.bytesRead);
  } finally {
    await file.close();
  }
};

export const listStickers = async (config: MediaConfig): Promise<Sticker[]> => {
  if (!config.stickerRoot) {
    throw new MediaUnavailableError();
  }
  let data;

  try {
    data = JSON.parse((await readLocal(config.stickerRoot, 'manifest.json', 64 * 1024)).toString('utf8'));
  } catch (error) {
    throw error instanceof MediaError ? error : new MediaError('无法读取表情素材清单。');
  }
  if (
    !Array.isArray(data) ||
    data.length > 100 ||
    data.some(
      item =>
        !item ||
        typeof item.id !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,40}$/u.test(item.id) ||
        typeof item.file !== 'string' ||
        !Array.isArray(item.tags) ||
        item.tags.length > 10 ||
        item.tags.some(tag => typeof tag !== 'string' || !tag || tag.length > 20)
    )
  ) {
    throw new MediaError('表情清单格式无效。');
  }
  if (new Set(data.map(item => item.id)).size !== data.length) {
    throw new MediaError('表情清单的 id 不能重复。');
  }

  return data;
};
export const chooseSticker = (items: Sticker[], query: string): Sticker | undefined =>
  items.find(item => item.id === query) ?? items.find(item => item.tags.includes(query));
export const loadSticker = async (item: Sticker, config: MediaConfig): Promise<Buffer> => {
  const data = await readLocal(config.stickerRoot, item.file, config.maxBytes);

  if (!imageMime(data)) {
    throw new MediaError('表情素材必须是 PNG、JPEG、WebP 或 GIF。');
  }

  return data;
};
