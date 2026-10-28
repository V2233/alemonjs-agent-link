import type { AgentModule } from '../agent/types';
import { getMediaConfig, MediaError } from '../media/config';
import { chooseSticker, listStickers, loadSticker, collectSticker, updateSticker } from '../media/stickers';

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
    api.tool({
      name: 'collect_sticker',
      description:
        '主人明确要求收藏当前消息或引用里的唯一图片作为表情时调用。按当前图片实际可见内容提供简短标签，不确定就留空；只能收藏本轮附件，不可指定 URL。',
      parameters: {
        type: 'object',
        properties: { tags: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 20 } } },
        additionalProperties: false
      },
      available: context => context.private && context.owner && !context.autonomous && Boolean(context.onStickerCollect),
      execute: async ({ tags }, context) => {
        const input = context.userText || '';
        const asked = /(?:收藏|收下|保存|存入|加入).{0,20}(?:表情|图片|这张图|这张)|(?:表情|图片|这张图).{0,20}(?:收藏|保存|收下|存入)/u.test(input);
        const denied = /(?:不要|别|不许|禁止|不用|不需要|不能).{0,16}(?:收藏|保存|收下|存入)|能.{0,12}(?:收藏|保存).{0,12}[吗么？?]/u.test(input);

        if (!context.private || !context.owner || context.autonomous || !context.onStickerCollect || !asked || denied)
          return { ok: false, message: '需要主人私聊明确要求收藏图片。' };
        try {
          const data = await context.onStickerCollect(context.signal);
          const result = await collectSticker(getMediaConfig(), data, (Array.isArray(tags) ? tags : []) as string[], context.signal);

          return { ok: true, ...result, message: result.existing ? '这张表情已在素材库中。' : '表情已收藏到素材库。' };
        } catch (error) {
          context.signal.throwIfAborted();

          return { ok: false, message: error instanceof MediaError ? error.message : '未能收藏表情。' };
        }
      }
    });
    api.tool({
      name: 'manage_sticker',
      description: '主人明确要求时修改指定表情编号的标签，或从清单移除表情；移除只影响清单，不删除图片文件。必须在用户本轮文字中给出完整编号。',
      parameters: {
        type: 'object',
        required: ['id', 'action'],
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 40 },
          action: { type: 'string', enum: ['tags', 'remove'] },
          tags: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 20 } }
        },
        additionalProperties: false
      },
      available: context => context.private && context.owner && !context.autonomous,
      execute: async ({ id, action, tags }, context) => {
        const input = context.userText || '';
        const identifier = String(id);
        const mentionsId = /^[a-zA-Z0-9_-]{1,40}$/u.test(identifier) && new RegExp(`(?:^|[^a-zA-Z0-9_-])${identifier}(?![a-zA-Z0-9_-])`, 'u').test(input);
        const allowed = action === 'remove' ? /删除|移除|去掉/u.test(input) : /修改|设置|更改|更新|标注/u.test(input) && /标签/u.test(input);
        const denied = /(?:不要|别|不许|禁止|不用|不需要|不能).{0,16}(?:删除|移除|修改|更新|标注)|能.{0,12}(?:删除|移除|修改|更新).{0,40}[吗么？?]/u.test(
          input
        );

        if (
          !context.private ||
          !context.owner ||
          context.autonomous ||
          !['tags', 'remove'].includes(String(action)) ||
          !mentionsId ||
          !allowed ||
          denied ||
          (action === 'tags' && !Array.isArray(tags))
        )
          return { ok: false, message: '需要主人明确指定表情编号和操作。' };
        try {
          const changed = await updateSticker(getMediaConfig(), identifier, action === 'remove' ? null : (tags as string[]), context.signal);

          return { ok: changed, message: !changed ? '未找到该表情编号。' : action === 'remove' ? '已从表情清单移除，原图片文件保留。' : '表情标签已更新。' };
        } catch (error) {
          context.signal.throwIfAborted();

          return { ok: false, message: error instanceof MediaError ? error.message : '表情清单修改未完成。' };
        }
      }
    });
  }
});
