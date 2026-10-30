import { getConfig } from 'alemonjs';
import { getAdminStore } from './admin-panel';
import { getMediaConfig, imageLibrary } from '../media/config';
import { generateImage } from '../media/image-generation';
import { withAdminMediaPreview } from '../media/admin-preview-context';

export const readImageSettings = async () => {
  const snapshot = await getAdminStore().read();
  const media = JSON.parse(snapshot.source)['alemonjs-agent-link']?.media || {};

  return {
    revision: snapshot.revision,
    imageLibrary: media.imageLibrary || [],
    activeImage: media.activeImage || '',
    legacyAvailable: Boolean(media.imageGen && !media.activeImage && !media.imageLibrary?.length)
  };
};
export const saveImageSettings = async (input: unknown) => {
  const body = input as { revision: string; imageLibrary: unknown; activeImage: string };

  if (
    !body ||
    typeof body.revision !== 'string' ||
    typeof body.activeImage !== 'string' ||
    Object.keys(body).some(key => !['revision', 'imageLibrary', 'activeImage', 'legacyAvailable'].includes(key))
  )
    throw new Error('生图设置无效');
  const library = imageLibrary(body.imageLibrary);

  if (body.activeImage && !library.some(item => item.id === body.activeImage)) throw new Error('默认生图配置不存在');
  const store = getAdminStore();
  const snapshot = await store.read();

  if (snapshot.revision !== body.revision) throw new Error('配置已变化');
  const source = JSON.parse(snapshot.source);
  const app = source['alemonjs-agent-link'];

  app.media = { ...app.media, imageLibrary: body.imageLibrary, activeImage: body.activeImage };
  await store.save(JSON.stringify(source), body.revision);
  let message = '生图设置已保存';

  try {
    getConfig().reload();
  } catch {
    message = '已保存，请重启后核对运行状态';
  }

  return { data: await readImageSettings(), message };
};
export const migrateImageSettings = async (input: unknown) => {
  const snapshot = await getAdminStore().read();

  if (!input || (input as { revision?: string }).revision !== snapshot.revision) throw new Error('配置已变化');
  const media = JSON.parse(snapshot.source)['alemonjs-agent-link']?.media || {};

  if (!media.imageGen || media.activeImage || media.imageLibrary?.length) throw new Error('没有待迁移的原有生图配置');

  return saveImageSettings({
    revision: snapshot.revision,
    activeImage: 'legacy-image',
    imageLibrary: [{ id: 'legacy-image', name: '原有生图服务', enabled: true, provider: media.imageGen }]
  });
};
let running = false;

export const previewImage = async (input: unknown) => {
  const body = input as { id?: string; prompt?: string };

  if (!body || typeof body.id !== 'string' || typeof body.prompt !== 'string' || !body.prompt.trim() || Array.from(body.prompt).length > 1000)
    throw new Error('试生成描述需要1–1000字');
  if (running) throw new Error('正在生成，请稍后再试');
  const config = getMediaConfig();
  const preset = config.imageLibrary?.find(item => item.id === body.id && item.enabled);

  if (body.id && !preset) throw new Error('生图配置不存在或已停用');
  if (body.id) config.imageGen = preset.provider;
  running = true;
  try {
    return await withAdminMediaPreview(() => generateImage(body.prompt, config, AbortSignal.timeout(config.timeoutMs)));
  } finally {
    running = false;
  }
};
