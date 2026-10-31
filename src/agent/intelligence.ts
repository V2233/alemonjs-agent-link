import { groupPolicy } from '../social/group-settings';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DSHBridgeConfig } from '../dsh/config';
import { withBudgetScope } from '../billing/budget';
import { getPersonalCredential } from '../credentials/personal';
import { getGroupCredential } from '../credentials/group';

export const intelligenceLevels = ['轻快', '标准', '深度', '专研'] as const;
export type IntelligenceLevel = (typeof intelligenceLevels)[number];
export type IntelligenceIdentity = { platform: string; channelId: string; userId: string; owner: boolean; private: boolean; admin?: boolean };
export const intelligenceProfiles = {
  轻快: { maxRounds: 2, maxContinuations: 0 },
  标准: { maxRounds: 4, maxContinuations: 0 },
  深度: { maxRounds: 8, maxContinuations: 1 },
  专研: { maxRounds: 12, maxContinuations: 2 }
};
export const intelligenceAccess = (identity: IntelligenceIdentity, bound: boolean, elevation = true) => ({
  entitled: identity.owner || (bound && elevation),
  canEdit: identity.owner || (bound && elevation && (identity.private || identity.admin === true)),
  defaultLevel: (identity.owner || (bound && elevation) ? '深度' : '标准') as IntelligenceLevel
});
export const resolveIntelligenceAccess = async (identity: IntelligenceIdentity, config?: DSHBridgeConfig) => {
  let bound = false;

  try {
    bound = Boolean(await withBudgetScope(identity, identity.private ? getPersonalCredential : getGroupCredential));
  } catch {
    // An unavailable credential store never grants extra privileges.
  }

  const elevation = identity.private || !config || groupPolicy(config, identity.channelId, identity.platform).boundKeyElevation !== false;

  return { ...intelligenceAccess(identity, bound, elevation), bound };
};
const file = (config: DSHBridgeConfig, identity: IntelligenceIdentity) => {
  if (!identity.platform || !identity.channelId || !identity.userId) throw new Error('无法确定当前身份与会话');
  const id = createHash('sha256')
    .update(JSON.stringify([identity.platform, identity.channelId]))
    .digest('hex');

  return join(dirname(config.workspaceRoot), 'intelligence', id + '.json');
};

export const readIntelligenceLevel = (config: DSHBridgeConfig, identity: IntelligenceIdentity, entitled: boolean): IntelligenceLevel | undefined => {
  if (!entitled) return undefined;
  try {
    const value = JSON.parse(readFileSync(file(config, identity), 'utf8')).level;

    return intelligenceLevels.includes(value) ? value : undefined;
  } catch {
    return undefined;
  }
};
export const saveIntelligenceLevel = async (config: DSHBridgeConfig, identity: IntelligenceIdentity, level: unknown) => {
  const access = await resolveIntelligenceAccess(identity, config);

  if (!access.canEdit) throw new Error('本人绑定 Key 后可设置；群内需本群绑定 Key 且由管理员设置。');
  if (level !== '默认' && !intelligenceLevels.includes(level as IntelligenceLevel)) throw new Error('请选择轻快、标准、深度、专研或默认');
  const path = file(config, identity);

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = path + '.' + process.pid + '.tmp';

  writeFileSync(temp, JSON.stringify({ level: level === '默认' ? null : level }), { mode: 0o600 });
  renameSync(temp, path);
};
export const turnIntelligence = async (config: DSHBridgeConfig, identity: IntelligenceIdentity, text: string, autonomous = false) => {
  const access = await resolveIntelligenceAccess(identity, config);
  let level = readIntelligenceLevel(config, identity, access.entitled) || access.defaultLevel;
  // Only an explicit leading instruction selects a one-turn override.
  const requested = text.match(/^\s*本次智能程度[：: ]+(轻快|标准|深度|专研)(?:\s|[，。]|$)/u)?.[1] as IntelligenceLevel | undefined;

  if (requested && access.entitled && !autonomous) level = requested;
  if (autonomous) level = '轻快';

  return { level, ...intelligenceProfiles[level], entitled: access.entitled, bound: access.bound };
};

export const ownerTerminalAllowed = (identity: IntelligenceIdentity, autonomous = false): boolean => identity.owner && identity.private && !autonomous;

// Only known official DeepSeek models receive provider-specific parameters.
export const reasoningParameters = (url: URL, model: string, level?: IntelligenceLevel) => {
  if (!level || url.hostname !== 'api.deepseek.com' || !/^deepseek-(?:v4|flash|pro)/u.test(model)) return {};

  return { thinking: { type: ['深度', '专研'].includes(level) ? 'enabled' : 'disabled' } };
};
