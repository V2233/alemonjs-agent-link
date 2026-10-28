import { getAppConfigValue } from 'alemonjs';
import { getCredentialPool, type PoolSelectionOptions } from '../credentials/pool';

export type DSHCredentialReport = { ok: boolean; status?: number };
export type DSHCredentials = {
  apiKey: string;
  personal?: boolean;
  scoped?: boolean;
  baseUrl?: string;
  model?: string;
  /** Pool metadata is process-local and is never serialized or logged. */
  endpointId?: string;
  attempt?: number;
  maxAttempts?: number;
  retryable?: (status: number) => boolean;
  report?: (outcome: DSHCredentialReport) => void;
  next?: () => DSHCredentials | null;
};

type CredentialConfig = {
  apiKey?: unknown;
  baseUrl?: unknown;
  model?: unknown;
  provider?: unknown;
  modelPool?: unknown;
};

const managedByConfigMessage = '模型凭证由 alemon.config.yaml 管理，保存配置后，后续请求自动使用新配置，无需重启机器人。';

export const getDSHCredentials = (
  config: CredentialConfig = getAppConfigValue<CredentialConfig>(),
  options: PoolSelectionOptions = {}
): Promise<DSHCredentials | null> => {
  try {
    const pool = getCredentialPool(config);

    if (pool) {
      // A configured pool is authoritative: never bypass its health or
      // maxConcurrent limits by silently falling back to the legacy key.
      return Promise.resolve(pool.select({ stable: true, ...options, reserve: options.reserve === true }));
    }
  } catch {
    // A malformed pool must not prevent the documented single-key fallback.
  }
  const apiKey = typeof config?.apiKey === 'string' ? config.apiKey.trim() : '';

  if (!apiKey) {
    return Promise.resolve(null);
  }

  return Promise.resolve({
    apiKey,
    baseUrl: typeof config?.baseUrl === 'string' && config.baseUrl.trim() ? config.baseUrl.trim() : undefined,
    ...(typeof config?.model === 'string' && config.model.trim() ? { model: config.model.trim() } : {})
  });
};

// Retained only to direct owners of an older command panel to configuration.
// Shared robot credentials must never be written by chat commands.
export const saveDSHCredentials = (_credentials: DSHCredentials): Promise<void> => Promise.reject(new Error(managedByConfigMessage));

export const removeDSHCredentials = (): Promise<void> => Promise.reject(new Error(managedByConfigMessage));

// Bound credentials are request-scoped; never pass them to the shared supervisor.
export const getChatCredentials = async (options: PoolSelectionOptions = {}): Promise<DSHCredentials | null> => {
  const { getBoundCredential } = await import('../credentials/scoped');
  const personal = await getBoundCredential();

  return personal
    ? { apiKey: personal.apiKey, baseUrl: 'https://api.deepseek.com', scoped: true, personal: personal.scope.channelId.startsWith('private:') }
    : getDSHCredentials(undefined, { purpose: options.purpose || 'chat', stickyKey: options.stickyKey, reserve: true, stable: false });
};
