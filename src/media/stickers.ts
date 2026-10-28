import { open, realpath, mkdir, lstat, readFile, rename, unlink } from 'node:fs/promises';
import { resolve, sep, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
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

const tagsValid = (tags: string[]): boolean =>
  Array.isArray(tags) &&
  tags.length <= 10 &&
  tags.every(tag => typeof tag === 'string' && tag.trim() === tag && tag.length > 0 && tag.length <= 20) &&
  new Set(tags).size === tags.length;

// A lock protects cooperating AgentLink processes; an atomic rename prevents readers seeing a partial manifest.
const mutate = async <T>(
  config: MediaConfig,
  signal: AbortSignal,
  change: (items: Sticker[], root: string) => Promise<{ items: Sticker[]; value: T }> | { items: Sticker[]; value: T }
): Promise<T> => {
  if (!config.stickerRoot) throw new MediaError('尚未配置表情素材目录。');
  signal.throwIfAborted();
  const root = await realpath(config.stickerRoot);
  const lockPath = join(root, '.agentlink-sticker.lock');
  let lock;

  try {
    lock = await open(lockPath, 'wx', 0o600);
  } catch {
    throw new MediaError('表情库正在修改或锁文件未清理，请稍后检查。');
  }
  const temp = join(root, `.manifest-${randomUUID()}.tmp`);

  try {
    const manifest = join(root, 'manifest.json');
    const stat = await lstat(manifest);

    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw new MediaError('表情清单必须是素材目录内不超过 64 KiB 的普通文件。');
    const before = await readFile(manifest);
    const items = await listStickers({ ...config, stickerRoot: root });
    const result = await change(items, root);
    const encoded = Buffer.from(`${JSON.stringify(result.items, null, 2)}\n`);

    if (encoded.length > 64 * 1024) throw new MediaError('表情清单超过大小限制。');
    signal.throwIfAborted();
    const staged = await open(temp, 'wx', 0o600);

    try {
      await staged.writeFile(encoded);
      await staged.sync();
    } finally {
      await staged.close();
    }
    signal.throwIfAborted();
    const current = await lstat(manifest);

    if (!current.isFile() || current.isSymbolicLink() || current.size > 64 * 1024 || !(await readFile(manifest)).equals(before))
      throw new MediaError('表情清单被其他程序修改，请重试。');
    await rename(temp, manifest);

    return result.value;
  } finally {
    await unlink(temp).catch(() => undefined);
    await lock.close();
    await unlink(lockPath).catch(() => undefined);
  }
};

export const collectSticker = async (config: MediaConfig, data: Buffer, tags: string[], signal: AbortSignal): Promise<{ id: string; existing: boolean }> => {
  const mime = imageMime(data);
  const ext = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' } as Record<string, string>)[mime || ''];

  if (!ext || data.length > config.maxBytes) throw new MediaError('表情图片格式无效或超过大小限制。');
  if (!tagsValid(tags)) throw new MediaError('表情标签无效或重复。');
  const digest = createHash('sha256').update(data).digest('hex');
  const id = `s_${digest.slice(0, 24)}`;
  const filename = `${digest}.${ext}`;

  return await mutate<{ id: string; existing: boolean }>(config, signal, async (items, root) => {
    const existing = items.find(item => item.id === id);

    if (existing) {
      const previous = await loadSticker(existing, { ...config, stickerRoot: root });

      if (!previous.equals(data)) throw new MediaError('表情编号冲突，请检查素材清单。');

      return { items, value: { id, existing: true } };
    }
    if (items.length >= 100) throw new MediaError('表情库已满，最多 100 项。');
    const directory = join(root, 'managed');

    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);

    if (!info.isDirectory() || info.isSymbolicLink()) throw new MediaError('表情素材目录无效。');
    const path = join(directory, filename);
    let file;

    try {
      file = await open(path, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const stored = await readLocal(root, `managed/${filename}`, config.maxBytes);

      if (!stored.equals(data)) throw new MediaError('表情文件冲突，请检查素材目录。');
    }
    if (file) {
      try {
        await file.writeFile(data);
        await file.sync();
      } finally {
        await file.close();
      }
    }

    return { items: [...items, { id, file: `managed/${filename}`, tags }], value: { id, existing: false } };
  });
};

export const updateSticker = async (config: MediaConfig, id: string, tags: string[] | null, signal: AbortSignal): Promise<boolean> => {
  if (!/^[a-zA-Z0-9_-]{1,40}$/u.test(id) || (tags !== null && !tagsValid(tags))) throw new MediaError('表情编号或标签无效。');

  return await mutate(config, signal, items => {
    const index = items.findIndex(item => item.id === id);

    if (index < 0) return { items, value: false };
    const updated = [...items];

    if (tags === null) updated.splice(index, 1);
    else updated[index] = { ...updated[index], tags };

    return { items: updated, value: true };
  });
};
