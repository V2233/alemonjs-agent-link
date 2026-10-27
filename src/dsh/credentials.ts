import { getAppConfigValue } from 'alemonjs';

export type DSHCredentials = {
  apiKey: string;
  personal?: boolean;
  scoped?: boolean;
  baseUrl?: string;
  model?: string;
};

type CredentialConfig = {
  apiKey?: unknown;
  baseUrl?: unknown;
};

const managedByConfigMessage = '模型凭证由 alemon.config.yaml 管理，保存配置后，后续请求自动使用新配置，无需重启机器人。';

export const getDSHCredentials = (config: CredentialConfig = getAppConfigValue<CredentialConfig>()): Promise<DSHCredentials | null> => {
  const apiKey = typeof config?.apiKey === 'string' ? config.apiKey.trim() : '';

  if (!apiKey) {
    return Promise.resolve(null);
  }

  return Promise.resolve({
    apiKey,
    baseUrl: typeof config?.baseUrl === 'string' && config.baseUrl.trim() ? config.baseUrl.trim() : undefined
  });
};

// Retained only to direct owners of an older command panel to configuration.
// Shared robot credentials must never be written by chat commands.
export const saveDSHCredentials = (_credentials: DSHCredentials): Promise<void> => Promise.reject(new Error(managedByConfigMessage));

export const removeDSHCredentials = (): Promise<void> => Promise.reject(new Error(managedByConfigMessage));

// Bound credentials are request-scoped; never pass them to the shared supervisor.
export const getChatCredentials = async (): Promise<DSHCredentials | null> => {
  const { getBoundCredential } = await import('../credentials/scoped');
  const personal = await getBoundCredential();

  return personal
    ? { apiKey: personal.apiKey, baseUrl: 'https://api.deepseek.com', scoped: true, personal: personal.scope.channelId.startsWith('private:') }
    : getDSHCredentials();
};
