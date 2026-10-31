import { getConfig } from 'alemonjs';
import { getAdminStore } from './admin-panel';
import { DEFAULT_STICKER_CAPACITY, MAX_STICKER_CAPACITY, getMediaConfig } from '../media/config';
import { collectSticker, editStickerAsset, listAssets, loadSticker, stickerRevision } from '../media/stickers';
import { imageMime } from '../media/download';
export const stickerAssets = async () => {
  const config = getMediaConfig();

  return {
    capacity: config.stickerMaxItems,
    items: (await listAssets(config)).map(item => {
      const { file: _file, ...publicItem } = item;

      return { ...publicItem, revision: stickerRevision(item) };
    })
  };
};
export const stickerImage = async (id: string) => {
  const config = getMediaConfig();
  const item = (await listAssets(config)).find(item => item.id === id);

  if (!item) throw new Error('表情不存在');
  const data = await loadSticker(item, config);

  return { data, mime: imageMime(data) };
};
export const saveStickerAsset = async (input: unknown, remove = false) => {
  const body = input as { id?: string; revision?: string; name?: string; tags?: string[] };

  if (!body || typeof body.id !== 'string' || typeof body.revision !== 'string' || (!remove && (typeof body.name !== 'string' || !Array.isArray(body.tags))))
    throw new Error('表情设置无效');
  await editStickerAsset(getMediaConfig(), body.id, body.revision, remove ? null : { name: body.name, tags: body.tags });
};
export const uploadStickerAsset = async (input: unknown) => {
  const body = input as { data?: string; name?: string; tags?: string[]; kind?: 'sticker' | 'avatar' };

  if (
    !body ||
    typeof body.data !== 'string' ||
    body.data.length > 7 * 1024 * 1024 ||
    !body.data.length ||
    body.data.length % 4 ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(body.data) ||
    typeof body.name !== 'string' ||
    !body.name.trim() ||
    !Array.isArray(body.tags) ||
    !['sticker', 'avatar'].includes(body.kind)
  )
    throw new Error('上传内容无效');
  const data = Buffer.from(body.data, 'base64');

  if (data.length > 5 * 1024 * 1024) throw new Error('图片最多5MB');

  return await collectSticker(getMediaConfig(), data, body.tags, AbortSignal.timeout(15000), { name: body.name.trim(), kind: body.kind, from: 'manual' });
};

export const readStickerSettings = async () => {
  const snapshot = await getAdminStore().read();
  const app = JSON.parse(snapshot.source)['alemonjs-agent-link'];

  return { revision: snapshot.revision, capacity: app?.media?.stickerMaxItems ?? DEFAULT_STICKER_CAPACITY, maxCapacity: MAX_STICKER_CAPACITY };
};
export const saveStickerSettings = async (input: unknown) => {
  const body = input as { revision?: string; capacity?: number };

  if (!body || typeof body.revision !== 'string' || !Number.isSafeInteger(body.capacity) || body.capacity < 1 || body.capacity > MAX_STICKER_CAPACITY)
    throw new Error('表情上限需为1–10000的整数');
  const store = getAdminStore();
  const snapshot = await store.read();

  if (snapshot.revision !== body.revision) throw new Error('配置已变化，请刷新后重试');
  const source = JSON.parse(snapshot.source);
  const app = source['alemonjs-agent-link'];

  app.media = { ...app.media, stickerMaxItems: body.capacity };
  await store.save(JSON.stringify(source), body.revision);
  let message = '表情上限已保存';

  try {
    getConfig().reload();
  } catch {
    message = '已保存，请重启后生效';
  }

  return { data: await readStickerSettings(), message };
};
