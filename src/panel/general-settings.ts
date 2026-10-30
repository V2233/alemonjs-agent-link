import { randomUUID } from 'node:crypto';
import { getConfig } from 'alemonjs';
import { getAdminStore } from './admin-panel';
import { resolveDSHConfig } from '../dsh/config';
import { AdminInputError } from './admin-error';
export const generalFields = [
  'groupWakeNames',
  'transport',
  'runtimeMode',
  'aiEnabled',
  'aiDisabledReason',
  'persona',
  'privateChatAccess',
  'privateAutoReply',
  'maxMessageLength',
  'bubbleDelayMs',
  'privateHistoryMaxTurns'
] as const;
export const validateGeneralSettings = (value: unknown) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AdminInputError('设置内容无效');
  const values = value as Record<string, unknown>;

  if (Object.keys(values).some(key => !generalFields.includes(key as (typeof generalFields)[number]))) throw new AdminInputError('包含不支持的设置项');
  if (Object.values(values).some(item => item === null || item === undefined)) throw new AdminInputError('设置值不能为空');
  if (values.persona !== undefined && !['assistant', 'dafeiyu'].includes(String(values.persona))) throw new AdminInputError('请选择有效的默认人设');
  // Reuse runtime constraints rather than silently clamp invalid form input.
  const numeric = { maxMessageLength: [1, 10000], bubbleDelayMs: [0, 5000], privateHistoryMaxTurns: [0, 100] };

  for (const [key, [min, max]] of Object.entries(numeric))
    if (values[key] !== undefined && (!Number.isSafeInteger(values[key]) || Number(values[key]) < min || Number(values[key]) > max))
      throw new AdminInputError('数值超出允许范围');
  resolveDSHConfig(values);

  return values;
};
export const projectGeneralSettings = (snapshot: { source: string; revision: string }) => {
  const app = JSON.parse(snapshot.source)['alemonjs-agent-link'] || {};
  const defaults = resolveDSHConfig();

  return {
    revision: snapshot.revision,
    values: Object.fromEntries(generalFields.map(key => [key, app[key] ?? defaults[key]])),
    customPromptConfigured: Boolean(app.defaultSystemPrompt),
    modulePersona: app.modules?.settings?.persona?.defaultId || ''
  };
};
export const readGeneralSettings = async () => projectGeneralSettings(await getAdminStore().read());
export const saveGeneralSettings = async (input: unknown) => {
  const body = input as { revision: string; values: unknown };

  if (!body || typeof body.revision !== 'string' || Object.keys(body).some(key => !['revision', 'values'].includes(key)))
    throw new AdminInputError('设置请求无效');
  const values = validateGeneralSettings(body.values);
  const store = getAdminStore();
  const snapshot = await store.read();

  if (snapshot.revision !== body.revision) throw new AdminInputError('配置已变化，请刷新后重试');
  const source = JSON.parse(snapshot.source);
  const app = (source['alemonjs-agent-link'] ||= {});
  const restart = values.transport !== undefined && values.transport !== (app.transport || 'qq-bot');

  if (values.aiEnabled === true && app.aiEnabled === false) app.aiNoticeEpoch = randomUUID();
  Object.assign(app, values);
  const saved = await store.save(JSON.stringify(source), body.revision);
  let message = restart ? '设置已保存；连接类型变更需要重启机器人后生效' : '设置已保存并重新加载';

  try {
    getConfig().reload();
  } catch {
    message = '设置已保存，但重新加载失败，请重启机器人后核对';
  }

  return { data: projectGeneralSettings(saved), message, restartRequired: restart };
};
