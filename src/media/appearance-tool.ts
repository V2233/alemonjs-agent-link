import type { AgentTool } from '../agent/types';
import type { DSHBridgeConfig } from '../dsh/config';
import { getPersonaStore } from '../companion/personas';
import { getAppearanceStore } from './appearance-store';
import { getMediaConfig } from './config';
import { editAppearanceImage } from './image-generation';
export const appearanceRequest = (text: string) => /长什么样|长啥样|你的样子|你的形象|你的照片|你的自拍|换装|换衣服|换.*装扮|穿.*给我看|给你换/u.test(text);
export const appearanceTool = (config: DSHBridgeConfig, deliver: (data: Buffer) => Promise<void>): AgentTool => ({
  name: 'persona_appearance',
  description:
    '查看当前人设的形象库原图，或以库中图片为真实参考调整装扮。被问长什么样、形象照时优先show；换装用restyle，不能自行无参考重画。库为空时说明需要上传。发送queued不代表已送达。',
  parameters: {
    type: 'object',
    properties: { action: { type: 'string', enum: ['list', 'show', 'restyle'] }, id: { type: 'string' }, prompt: { type: 'string', maxLength: 2000 } },
    required: ['action'],
    additionalProperties: false
  },
  available: context => !context.autonomous,
  execute: async (args, context) => {
    const personaId = String(getPersonaStore(config).activeSelection(context) || config.modules?.settings?.persona?.defaultId || config.persona);
    const store = getAppearanceStore(config);
    const rows = store.list(personaId);

    if (args.action === 'list') return { ok: true, items: rows };
    const id = typeof args.id === 'string' && args.id ? args.id : rows[0]?.id;

    if (!id) return { ok: false, message: '当前人设形象库为空，请先在管理页上传形象，不能假称找到了形象。' };
    const { item, data } = store.read(id, personaId);

    if (args.action === 'show') {
      context.signal.throwIfAborted();
      await deliver(data);

      return { ok: true, id: item.id, name: item.name, delivery: 'queued-for-this-reply' };
    }
    if (args.action !== 'restyle' || typeof args.prompt !== 'string' || !args.prompt.trim()) throw new Error('请选择查看或填写装扮描述');
    const media = getMediaConfig();

    if (media.imageGen?.ownerOnly && !context.owner) throw new Error('当前图片编辑仅向机器人主人开放');
    const result = await editAppearanceImage(args.prompt, data, media, context.signal);

    context.signal.throwIfAborted();
    // The derivative is retained for review, and never silently replaces the default reference.
    const derived = await store.add(personaId, args.prompt.slice(0, 80), result, item.id);

    await deliver(result);

    return { ok: true, id: derived.id, parentId: item.id, delivery: 'queued-for-this-reply', notice: '二创已入库，默认形象保持原选择；未确认平台送达。' };
  }
});
