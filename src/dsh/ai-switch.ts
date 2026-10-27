import { getAppConfig } from 'alemonjs';
import { DSHError } from './errors';
import type { AgentConfig, DSHBridgeConfig } from './config';

export const defaultDisabledReason = 'AI 暂时关闭，请稍后再来。';
export const aiDisabledMessage = (config: Pick<DSHBridgeConfig, 'aiDisabledReason'>) => config.aiDisabledReason?.trim() || defaultDisabledReason;

// Read the live app view at every outbound boundary, including queued requests.
export const assertAIEnabled = (snapshot?: Pick<DSHBridgeConfig, 'aiEnabled' | 'aiDisabledReason'>): void => {
  const current = getAppConfig<AgentConfig>().value;
  const disabled = current.aiEnabled === false ? current : snapshot?.aiEnabled === false ? snapshot : undefined;

  if (disabled) throw new DSHError('disabled', aiDisabledMessage(disabled));
};

export const setAIEnabled = (owner: boolean, enabled: boolean, reason = ''): string => {
  if (!owner) throw new Error('只有机器人主人可以设置 AI 总开关。');
  if (reason.length > 500) throw new Error('关闭原因最多 500 字。');
  const app = getAppConfig<AgentConfig>();

  if (!app.name || !app.path) throw new Error('无法确认配置文件位置，未修改 AI 开关。');
  const aiDisabledReason = enabled ? app.value.aiDisabledReason || '' : reason.trim() || defaultDisabledReason;

  app.saveValue({ ...app.value, aiEnabled: enabled, aiDisabledReason });
  if (app.value.aiEnabled !== enabled || app.value.aiDisabledReason !== aiDisabledReason) throw new Error('AI 开关保存失败。');

  return enabled ? 'AI 请求已全局开启。' : `AI 请求已全局关闭。\n原因：${aiDisabledReason}\n主人可发送 /开启 恢复。`;
};
