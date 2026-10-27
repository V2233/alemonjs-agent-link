import type { AgentModule } from '../agent/types';
import { getMediaConfig, MediaError } from '../media/config';
import { chooseSticker, listStickers, loadSticker } from '../media/stickers';

export const stickerModule = (): AgentModule => ({
  id: 'stickers',
  name: '表情包',
  version: '1.0.0',
  apiVersion: 1,
  setup(api) {
    api.tool({
      name: 'list_stickers',
      readOnly: true,
      description: '查询当前配置的表情素材。可按名称编号或标签的部分文字搜索；只返回编号和标签，不返回本机路径。',
      parameters: { type: 'object', properties: { query: { type: 'string', maxLength: 40 } }, additionalProperties: false },
      available: context => !context.autonomous && Boolean(context.onSticker),
      execute: async ({ query }, context) => {
        try {
          context.signal.throwIfAborted();
          const text = String(query || '')
            .trim()
            .toLowerCase();
          const config = getMediaConfig();

          if (!config.stickerRoot) return { ok: false, message: '尚未配置表情素材目录。' };
          const items = (await listStickers(config)).filter(
            item => !text || item.id.toLowerCase().includes(text) || item.tags.some(tag => tag.toLowerCase().includes(text))
          );

          context.signal.throwIfAborted();

          return { ok: true, count: items.length, items: items.map(({ id, tags }) => ({ id, tags })) };
        } catch (error) {
          context.signal.throwIfAborted();

          return { ok: false, message: error instanceof MediaError ? error.message : '无法读取表情素材。' };
        }
      }
    });
    api.tool({
      name: 'send_sticker',
      description: '根据编号或完整标签向当前会话发送一个已有表情，用户要求表情时可先查询。只在平台回执成功后返回成功；不支持指定其他接收人。',
      parameters: { type: 'object', required: ['query'], properties: { query: { type: 'string', minLength: 1, maxLength: 40 } }, additionalProperties: false },
      available: context => !context.autonomous && Boolean(context.onSticker),
      execute: async ({ query }, context) => {
        try {
          context.signal.throwIfAborted();
          const config = getMediaConfig();

          if (!config.stickerRoot) return { ok: false, message: '尚未配置表情素材目录。' };
          const item = chooseSticker(await listStickers(config), String(query).trim());

          if (!item) return { ok: false, message: '没有找到该编号或完整标签的表情。' };
          const data = await loadSticker(item, config);

          context.signal.throwIfAborted();
          if (!context.onSticker) return { ok: false, message: '当前会话不支持发送表情。' };
          await context.onSticker(item, data);

          return { ok: true, id: item.id, message: '平台已接受表情发送。' };
        } catch (error) {
          context.signal.throwIfAborted();

          return { ok: false, message: error instanceof MediaError ? error.message : '表情发送未获成功回执，请勿自动重试。' };
        }
      }
    });
  }
});
