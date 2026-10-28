import { getAppConfigValue } from 'alemonjs';
import { setTimeout as delay } from 'node:timers/promises';
import { getCredentialPool, type PoolSelectionOptions } from '../credentials/pool';

export type DSHCredentialUsage = { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; prompt_cache_hit_tokens?: number };
export type DSHCredentialReport = { ok: boolean; status?: number; headers?: Headers };
export type DSHCredentials = {
  apiKey: string;
  personal?: boolean;
  scoped?: boolean;
  baseUrl?: string;
  model?: string;
  pricing?: { input: number; output: number; cached: number };
  /** Pool metadata is process-local and is never serialized or logged. */
  endpointId?: string;
  attempt?: number;
  maxAttempts?: number;
  retryable?: (status: number) => boolean;
  startedAt?: number;
  retryBudgetMs?: number;
  retryJitterMs?: number;
  reportUsage?: (usage: DSHCredentialUsage) => void;
  invalidate?: (status?: number) => void;
  disable?: () => void;
  report?: (outcome: DSHCredentialReport) => void;
  next?: (options?: { fallback?: boolean }) => DSHCredentials | null;
};

type CredentialConfig = {
  apiKey?: unknown;
  baseUrl?: unknown;
  model?: unknown;
  provider?: unknown;
  dshHomeRoot?: unknown;
  modelPool?: unknown;
};

const managedByConfigMessage = '模型凭证由 alemon.config.yaml 管理，保存配置后，后续请求自动使用新配置，无需重启机器人。';

const legacyCredentials = (config: CredentialConfig): DSHCredentials | null => {
  const apiKey = typeof config?.apiKey === 'string' ? config.apiKey.trim() : '';

  if (!apiKey) return null;

  return {
    apiKey,
    baseUrl: typeof config?.baseUrl === 'string' && config.baseUrl.trim() ? config.baseUrl.trim() : undefined,
    ...(typeof config?.model === 'string' && config.model.trim() ? { model: config.model.trim() } : {})
  };
};

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

  return Promise.resolve(legacyCredentials(config));
};

/** Sandbox workers speak the deepseek-official Messages protocol. Prefer a
 * matching pooled endpoint, then fall back to the legacy DeepSeek key. */
export const getSandboxCredentials = (): Promise<DSHCredentials | null> => {
  const config = getAppConfigValue<CredentialConfig>();
  const provider = typeof config.provider === 'string' && config.provider.trim() ? config.provider.trim() : 'deepseek-official';

  try {
    const pool = getCredentialPool(config);
    const selected = pool?.select({ purpose: 'chat', stable: true, reserve: false, provider });

    if (selected) return Promise.resolve(selected);
  } catch {
    // Fall through to the legacy key; config validation reports malformed pools.
  }

  return Promise.resolve(legacyCredentials(config));
};

// Retained only to direct owners of an older command panel to configuration.
// Shared robot credentials must never be written by chat commands.
export const saveDSHCredentials = (_credentials: DSHCredentials): Promise<void> => Promise.reject(new Error(managedByConfigMessage));

export const removeDSHCredentials = (): Promise<void> => Promise.reject(new Error(managedByConfigMessage));

// Bound credentials are request-scoped; never pass them to the shared supervisor.
export const getChatCredentials = async (options: PoolSelectionOptions = {}): Promise<DSHCredentials | null> => {
  const { getBoundCredential } = await import('../credentials/scoped');
  const personal = await getBoundCredential();

  if (personal) {
    return { apiKey: personal.apiKey, baseUrl: 'https://api.deepseek.com', scoped: true, personal: personal.scope.channelId.startsWith('private:') };
  }
  const config = getAppConfigValue<CredentialConfig>();
  const waitMs = getCredentialPool(config)?.config.queueMaxWaitMs ?? 0;
  const deadline = Date.now() + waitMs;

  for (;;) {
    const credentials = await getDSHCredentials(undefined, {
      purpose: options.purpose || 'chat',
      stickyKey: options.stickyKey,
      reserve: true,
      stable: false,
      estimatedTokens: options.estimatedTokens,
      waitForCapacity: true
    });

    if (credentials || waitMs <= 0 || Date.now() >= deadline) return credentials;
    await delay(50);
  }
};
