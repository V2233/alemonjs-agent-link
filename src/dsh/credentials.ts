import { getConfigValue } from 'alemonjs';

export type DSHCredentials = {
  apiKey: string;
  baseUrl?: string;
  model?: string;
};

type CredentialConfig = {
  'alemonjs-agent-link'?: {
    apiKey?: unknown;
    baseUrl?: unknown;
  };
};

const managedByConfigMessage = '模型凭证由 alemon.config.yaml 管理，请修改配置后重启服务。';

export const getDSHCredentials = (value: CredentialConfig = getConfigValue()): Promise<DSHCredentials | null> => {
  const config = value?.['alemonjs-agent-link'];
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
// Credentials must never be written by chat commands.
export const saveDSHCredentials = (_credentials: DSHCredentials): Promise<void> => Promise.reject(new Error(managedByConfigMessage));

export const removeDSHCredentials = (): Promise<void> => Promise.reject(new Error(managedByConfigMessage));
