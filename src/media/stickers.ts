import { open, realpath, mkdir, lstat, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { relative, resolve, sep, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { MediaError, MediaUnavailableError, type MediaConfig } from './config';
import { imageMime } from './download';
import { imageInfo, type ImageInfo } from './image-info';

export type StickerSource = 'manual' | 'auto' | 'forge' | 'import' | 'site' | 'file' | 'legacy';
export type StickerKind = 'sticker' | 'avatar';
export type Sticker = {
  id: string;
  file: string;
  tags: string[];
  name?: string;
  from?: StickerSource;
  addedAt?: number;
  uses?: number;
  lastUsed?: number;
  width?: number;
  height?: number;
  bytes?: number;
  confidence?: number;
  emojiId?: string;
  kind?: StickerKind;
  category?: string;
  context?: string;
  sourceUrl?: string;
  license?: string;
};
export type StickerCollectMeta = {
  name?: string;
  from?: StickerSource;
  confidence?: number;
  addedAt?: number;
  width?: number;
  height?: number;
  kind?: StickerKind;
  category?: string;
  context?: string;
  sourceUrl?: string;
  license?: string;
};
const SOURCES: StickerSource[] = ['manual', 'auto', 'forge', 'import', 'site', 'file', 'legacy'];
const MANIFEST_MAX = 256 * 1024;
const MAX_ENTRIES = 500;
const ID_PATTERN = /^[a-zA-Z0-9_-]{1,40}$/u;
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

const hasControl = (value: string): boolean =>
  Array.from(value).some(char => {
    const code = char.codePointAt(0) ?? 0;

    return code < 0x20 || code === 0x7f;
  });
const optionalInteger = (value: unknown, min: number, max: number): boolean =>
  value === undefined || (Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max);
const validItem = (item: unknown): item is Sticker => {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
  const row = item as Record<string, unknown>;

  return (
    typeof row.id === 'string' &&
    ID_PATTERN.test(row.id) &&
    typeof row.file === 'string' &&
    Array.isArray(row.tags) &&
    row.tags.length <= 10 &&
    row.tags.every(tag => typeof tag === 'string' && tag.trim() === tag && tag.length > 0 && tag.length <= 20) &&
    (row.name === undefined || (typeof row.name === 'string' && row.name.trim() === row.name && row.name.length > 0 && row.name.length <= 24)) &&
    (row.from === undefined || SOURCES.includes(row.from as StickerSource)) &&
    optionalInteger(row.addedAt, 0, Number.MAX_SAFE_INTEGER) &&
    optionalInteger(row.uses, 0, Number.MAX_SAFE_INTEGER) &&
    optionalInteger(row.lastUsed, 0, Number.MAX_SAFE_INTEGER) &&
    optionalInteger(row.width, 1, 8192) &&
    optionalInteger(row.height, 1, 8192) &&
    optionalInteger(row.bytes, 1, 25 * 1024 * 1024) &&
    (row.confidence === undefined || (typeof row.confidence === 'number' && Number.isFinite(row.confidence) && row.confidence >= 0 && row.confidence <= 1)) &&
    (row.emojiId === undefined || (typeof row.emojiId === 'string' && /^[A-Za-z0-9_-]{1,64}$/u.test(row.emojiId))) &&
    (row.kind === undefined || row.kind === 'sticker' || row.kind === 'avatar') &&
    (row.category === undefined ||
      (typeof row.category === 'string' &&
        row.category.trim() === row.category &&
        row.category.length > 0 &&
        row.category.length <= 20 &&
        !hasControl(row.category))) &&
    (row.sourceUrl === undefined ||
      (typeof row.sourceUrl === 'string' && row.sourceUrl.length <= 2048 && /^https:\/\//u.test(row.sourceUrl) && !hasControl(row.sourceUrl))) &&
    (row.license === undefined ||
      (typeof row.license === 'string' && row.license.length <= 80 && row.license.trim() === row.license && !hasControl(row.license)))
  );
};

/** Create the default library on first use without overwriting an existing manifest. */
export const ensureStickerRoot = async (config: MediaConfig): Promise<void> => {
  if (!config.stickerRoot) return;
  const root = config.stickerRoot;

  try {
    const info = await lstat(root);

    if (!info.isDirectory() || info.isSymbolicLink()) throw new MediaError('表情素材目录无效。');
  } catch (error) {
    if (error instanceof MediaError) throw error;
    await mkdir(root, { recursive: true, mode: 0o700 });
  }
  const manifest = join(root, 'manifest.json');

  try {
    await lstat(manifest);
  } catch {
    await writeFile(manifest, '[]\n', { mode: 0o600, flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
  }
};

export const listAssets = async (config: MediaConfig): Promise<Sticker[]> => {
  if (!config.stickerRoot) {
    throw new MediaUnavailableError();
  }
  await ensureStickerRoot(config);
  let data;

  try {
    data = JSON.parse((await readLocal(config.stickerRoot, 'manifest.json', MANIFEST_MAX)).toString('utf8'));
  } catch (error) {
    throw error instanceof MediaError ? error : new MediaError('无法读取表情素材清单。');
  }
  if (!Array.isArray(data) || data.length > MAX_ENTRIES || !data.every(validItem)) {
    throw new MediaError('表情清单格式无效或超过数量上限。');
  }
  if (new Set(data.map(item => item.id)).size !== data.length) {
    throw new MediaError('表情清单的 id 不能重复。');
  }

  return data;
};
export const listStickers = async (config: MediaConfig): Promise<Sticker[]> => (await listAssets(config)).filter(item => item.kind !== 'avatar');
export const readStickerPath = async (config: MediaConfig, source: string, maxBytes: number): Promise<Buffer> => {
  if (!config.stickerRoot) throw new MediaError('尚未配置表情素材目录。');
  const root = await realpath(config.stickerRoot);
  const target = await realpath(resolve(root, source));

  if (!target.startsWith(`${root}${sep}`)) throw new MediaError('本地图片必须位于表情素材目录内。');

  return await readLocal(root, relative(root, target), Math.min(maxBytes, config.maxBytes));
};

export const chooseSticker = (items: Sticker[], query: string): Sticker | undefined =>
  items.find(item => item.id === query) ?? items.find(item => item.name === query) ?? items.find(item => item.tags.includes(query));
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
const mergeTags = (current: string[], incoming: string[]): string[] => {
  const merged = [...current];

  for (const tag of incoming) {
    if (!merged.includes(tag) && merged.length < 10) merged.push(tag);
  }

  return merged;
};
const normalizeMeta = (meta: StickerCollectMeta, info: ImageInfo | undefined, bytes: number): Omit<Sticker, 'id' | 'file' | 'tags'> => {
  const from = meta.from ?? 'manual';

  if (!SOURCES.includes(from)) throw new MediaError('表情来源无效。');
  const name = typeof meta.name === 'string' ? meta.name.replace(/\s+/gu, ' ').trim() : undefined;

  if (name !== undefined && (!name || Array.from(name).length > 24 || hasControl(name))) {
    throw new MediaError('表情名称无效。');
  }
  const confidence = meta.confidence;

  if (confidence !== undefined && (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1)) {
    throw new MediaError('表情判断置信度无效。');
  }
  const addedAt = meta.addedAt ?? Date.now();

  if (!Number.isSafeInteger(addedAt) || addedAt < 0) throw new MediaError('表情入库时间无效。');
  const kind = meta.kind ?? 'sticker';

  if (kind !== 'sticker' && kind !== 'avatar') throw new MediaError('图片类型无效。');
  const category = typeof meta.category === 'string' ? meta.category.replace(/\s+/gu, ' ').trim() : undefined;

  if (category !== undefined && (!category || Array.from(category).length > 20 || hasControl(category))) {
    throw new MediaError('图片分类无效。');
  }
  const context = typeof meta.context === 'string' ? meta.context.replace(/\s+/gu, ' ').trim() : undefined;

  if (context !== undefined && (!context || Array.from(context).length > 200 || hasControl(context))) {
    throw new MediaError('图片用途说明无效。');
  }
  const sourceUrl = typeof meta.sourceUrl === 'string' ? meta.sourceUrl.trim() : undefined;

  if (sourceUrl !== undefined && (!/^https:\/\//u.test(sourceUrl) || sourceUrl.length > 2048 || hasControl(sourceUrl))) {
    throw new MediaError('图片来源地址无效。');
  }
  const license = typeof meta.license === 'string' ? meta.license.trim() : undefined;

  if (license !== undefined && (!license || license.length > 80 || hasControl(license))) throw new MediaError('图片许可信息无效。');
  const width = info?.width ?? meta.width;
  const height = info?.height ?? meta.height;

  if (
    (width !== undefined && (!Number.isSafeInteger(width) || width < 1 || width > 8192)) ||
    (height !== undefined && (!Number.isSafeInteger(height) || height < 1 || height > 8192))
  ) {
    throw new MediaError('表情图片尺寸无效。');
  }

  return {
    ...(name ? { name } : {}),
    from,
    addedAt,
    ...(confidence !== undefined ? { confidence } : {}),
    kind,
    ...(category ? { category } : {}),
    ...(context ? { context } : {}),
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(license ? { license } : {}),
    ...(width !== undefined && height !== undefined ? { width, height } : {}),
    bytes
  };
};

// A lock protects cooperating AgentLink processes; an atomic rename prevents readers seeing a partial manifest.
const mutate = async <T>(
  config: MediaConfig,
  signal: AbortSignal,
  change: (items: Sticker[], root: string) => Promise<{ items: Sticker[]; value: T }> | { items: Sticker[]; value: T }
): Promise<T> => {
  if (!config.stickerRoot) throw new MediaError('尚未配置表情素材目录。');
  signal.throwIfAborted();
  await ensureStickerRoot(config);
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

    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MANIFEST_MAX) throw new MediaError('表情清单必须是素材目录内不超过 256 KiB 的普通文件。');
    const before = await readFile(manifest);
    const items = await listAssets({ ...config, stickerRoot: root });
    const result = await change(items, root);
    const encoded = Buffer.from(`${JSON.stringify(result.items, null, 2)}\n`);

    if (encoded.length > MANIFEST_MAX) throw new MediaError('表情清单超过大小限制。');
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

    if (!current.isFile() || current.isSymbolicLink() || current.size > MANIFEST_MAX || !(await readFile(manifest)).equals(before))
      throw new MediaError('表情清单被其他程序修改，请重试。');
    await rename(temp, manifest);

    return result.value;
  } finally {
    await unlink(temp).catch(() => undefined);
    await lock.close();
    await unlink(lockPath).catch(() => undefined);
  }
};

const pickEviction = (items: Sticker[]): number => {
  let best = -1;

  for (let index = 0; index < items.length; index++) {
    const item = items[index];

    if (item.from !== 'auto') continue;
    if (best < 0) {
      best = index;
      continue;
    }
    const previous = items[best];
    const uses = item.uses ?? 0;
    const previousUses = previous.uses ?? 0;
    const at = item.lastUsed ?? item.addedAt ?? 0;
    const previousAt = previous.lastUsed ?? previous.addedAt ?? 0;

    if (uses < previousUses || (uses === previousUses && at < previousAt)) best = index;
  }

  return best;
};
const removeStoredFile = async (config: MediaConfig, file: string): Promise<void> => {
  if (!config.stickerRoot || !/^managed\/[a-f0-9]{16,64}\.(?:png|jpg|webp|gif)$/u.test(file)) return;
  try {
    const root = await realpath(config.stickerRoot);
    const target = resolve(root, file);

    if (!target.startsWith(`${root}${sep}`)) return;
    let current: Sticker[];

    try {
      current = await listAssets({ ...config, stickerRoot: root });
    } catch {
      return;
    }

    // Never delete a file that is still referenced or was placed outside the managed directory.
    if (current.some(item => item.file === file)) return;
    await unlink(target);
  } catch {
    /* An orphaned file is safer than deleting one that another manifest still references. */
  }
};

export const collectSticker = async (
  config: MediaConfig,
  data: Buffer,
  tags: string[],
  signal: AbortSignal,
  meta: StickerCollectMeta = {}
): Promise<{ id: string; existing: boolean; item: Sticker }> => {
  const mime = imageMime(data);
  const ext = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' } as Record<string, string>)[mime || ''];

  if (!ext || data.length > config.maxBytes) throw new MediaError('表情图片格式无效或超过大小限制。');
  if (!tagsValid(tags)) throw new MediaError('表情标签无效或重复。');
  const record = normalizeMeta(meta, imageInfo(data), data.length);
  const digest = createHash('sha256').update(data).digest('hex');
  const id = `s_${digest.slice(0, 24)}`;
  const filename = `${digest}.${ext}`;

  const result = await mutate<{ id: string; existing: boolean; item: Sticker; removed?: string[] }>(config, signal, async (items, root) => {
    const existing = items.find(item => item.id === id);

    if (existing) {
      const previous = await loadSticker(existing, { ...config, stickerRoot: root });

      if (!previous.equals(data)) throw new MediaError('表情编号冲突，请检查素材清单。');
      const merged: Sticker = {
        ...existing,
        tags: mergeTags(existing.tags, tags),
        ...(existing.name || !record.name ? {} : { name: record.name }),
        ...(existing.category || !record.category ? {} : { category: record.category }),
        ...(existing.context || !record.context ? {} : { context: record.context }),
        ...(existing.sourceUrl || !record.sourceUrl ? {} : { sourceUrl: record.sourceUrl }),
        ...(existing.license || !record.license ? {} : { license: record.license })
      };

      return {
        items: items.map(item => (item.id === id ? merged : item)),
        value: { id, existing: true, item: merged }
      };
    }
    let nextItems = items;
    const removed: string[] = [];

    // A lowered capacity or an externally grown manifest can require more than one eviction.
    while (nextItems.length >= config.stickerMaxItems) {
      const index = pickEviction(nextItems);

      if (index < 0) throw new MediaError('表情库已满，且没有可清理的自动收藏。');
      removed.push(nextItems[index].file);
      nextItems = nextItems.filter((_, position) => position !== index);
    }
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
    const item: Sticker = { id, file: `managed/${filename}`, tags, ...record };

    return { items: [...nextItems, item], value: { id, existing: false, item, ...(removed.length ? { removed } : {}) } };
  });

  for (const file of result.removed ?? []) await removeStoredFile(config, file);

  return { id: result.id, existing: result.existing, item: result.item };
};

export const renameSticker = async (config: MediaConfig, id: string, name: string, signal: AbortSignal): Promise<boolean> => {
  const validName = typeof name === 'string' && name.length > 0 && name.trim() === name && Array.from(name).length <= 24 && !hasControl(name);

  if (!ID_PATTERN.test(id) || !validName) throw new MediaError('表情编号或名称无效。');

  return await mutate(config, signal, items => {
    const index = items.findIndex(item => item.id === id);

    if (index < 0) return { items, value: false };
    const updated = [...items];

    updated[index] = { ...updated[index], name };

    return { items: updated, value: true };
  });
};

export const updateSticker = async (config: MediaConfig, id: string, tags: string[] | null, signal: AbortSignal): Promise<boolean> => {
  if (!ID_PATTERN.test(id) || (tags !== null && !tagsValid(tags))) throw new MediaError('表情编号或标签无效。');

  return await mutate(config, signal, items => {
    const index = items.findIndex(item => item.id === id);

    if (index < 0) return { items, value: false };
    const updated = [...items];

    if (tags === null) updated.splice(index, 1);
    else updated[index] = { ...updated[index], tags };

    return { items: updated, value: true };
  });
};

export const setStickerEmoji = async (config: MediaConfig, id: string, emojiId: string, signal: AbortSignal): Promise<boolean> => {
  if (!ID_PATTERN.test(id) || !/^[A-Za-z0-9_-]{1,64}$/u.test(emojiId)) throw new MediaError('表情编号或 QQ 收藏标识无效。');

  return await mutate(config, signal, items => {
    const index = items.findIndex(item => item.id === id);

    if (index < 0) return { items, value: false };
    const updated = [...items];

    updated[index] = { ...updated[index], emojiId };

    return { items: updated, value: true };
  });
};

export const markStickerUsed = async (config: MediaConfig, id: string, signal: AbortSignal): Promise<boolean> => {
  if (!ID_PATTERN.test(id)) return false;

  return await mutate(config, signal, items => {
    const index = items.findIndex(item => item.id === id);

    if (index < 0) return { items, value: false };
    const updated = [...items];

    updated[index] = { ...updated[index], uses: (updated[index].uses ?? 0) + 1, lastUsed: Date.now() };

    return { items: updated, value: true };
  });
};
