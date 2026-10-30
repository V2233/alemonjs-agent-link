import { getAppConfigValue } from 'alemonjs';
import { setTimeout as delay } from 'node:timers/promises';
import { getCredentialPool, type PoolSelectionOptions } from '../credentials/pool';

export type DSHCredentialUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
};
export type DSHCredentialReport = {
  ok: boolean;
  status?: number;
  detail?: string;
  errorKind?: string;
  headers?: Headers;
  /** 本次请求的真实耗时，仅用于观测，不影响调度顺序。 */ latencyMs?: number;
};
export type DSHCredentials = {
  apiKey: string;
  personal?: boolean;
  scoped?: boolean;
  baseUrl?: string;
  model?: string;
  pricing?: { input: number; output: number; cached: number };
  /** Pool metadata is process-local and is never serialized or logged. */
  hold?: () => void;
  endTask?: () => void;
  renew?: (estimatedTokens: number) => DSHCredentials | null;
  initialFailover?: boolean;
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
  markSent?: () => void;
  report?: (outcome: DSHCredentialReport) => void;
  next?: (options?: { fallback?: boolean; initialTask?: boolean }) => DSHCredentials | null;
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
      return Promise.resolve(pool.select({ ...options, reserve: options.reserve === true }));
    }
  } catch {
    // A malformed pool must not prevent the documented single-key fallback.
  }

  return Promise.resolve(legacyCredentials(config));
};

/** Dedicated workspace endpoint for agent_workspace; falls back to the
 * sandbox credential when no endpoint is explicitly marked as workspace. */
export const getWorkspaceCredentials = (options: { stickyKey?: string } = {}): Promise<DSHCredentials | null> => {
  const config = getAppConfigValue<CredentialConfig>();

  try {
    const pool = getCredentialPool(config);
    const selected = pool?.select({ purpose: 'chat', stickyKey: options.stickyKey, stable: false, reserve: true, workspaceOnly: true });

    if (selected) return Promise.resolve(selected);
  } catch {
    // Fall through to the sandbox credential; config validation reports malformed pools.
  }

  return getSandboxCredentials(true);
};

/** Sandbox workers speak the deepseek-official Messages protocol. Prefer a
 * matching pooled endpoint, then fall back to the legacy DeepSeek key. */
export const getSandboxCredentials = (reserve = false): Promise<DSHCredentials | null> => {
  const config = getAppConfigValue<CredentialConfig>();
  const provider = typeof config.provider === 'string' && config.provider.trim() ? config.provider.trim() : 'deepseek-official';

  try {
    const pool = getCredentialPool(config);
    const selected = pool?.select({ purpose: 'chat', stable: true, reserve, provider });

    if (pool) return Promise.resolve(selected);
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
    options.signal?.throwIfAborted();
    const credentials = await getDSHCredentials(undefined, {
      purpose: options.purpose || 'chat',
      stickyKey: options.stickyKey,
      reserve: true,
      stable: false,
      estimatedTokens: options.estimatedTokens,
      requestId: options.requestId,
      waitForCapacity: Date.now() < deadline
    });

    if (credentials || waitMs <= 0 || Date.now() >= deadline) return credentials;
    await delay(50, undefined, { signal: options.signal });
  }
};

/** One lease for a complete logical turn, including tool rounds. */
export const createChatTaskCredentials = () => {
  let lease: DSHCredentials | null = null;
  let current: DSHCredentials | null = null;
  let acquiring = false;
  const lifetime = new AbortController();
  let committed = false;
  const wrapInitial = (selected: DSHCredentials): DSHCredentials => ({
    ...selected,
    initialFailover: true,
    report: outcome => {
      if (outcome.ok) committed = true;
      selected.report?.(outcome);
    },
    next: () => {
      if (committed || lifetime.signal.aborted) return null;
      const next = selected.next?.({ initialTask: true });

      if (!next) return null;
      lease = next;
      current = next;

      return wrapInitial(next);
    }
  });

  return {
    async acquire(options: PoolSelectionOptions): Promise<DSHCredentials | null> {
      const signal = options.signal ? AbortSignal.any([options.signal, lifetime.signal]) : lifetime.signal;

      signal.throwIfAborted();
      if (acquiring) throw new Error('同一任务不能并发获取模型轮次');
      acquiring = true;
      try {
        if (lease) {
          committed = true;
          const deadline = Date.now() + (getCredentialPool(getAppConfigValue<CredentialConfig>())?.config.queueMaxWaitMs || 0);
          let next = lease.renew ? lease.renew(options.estimatedTokens || 0) : lease;

          while (!next && Date.now() < deadline) {
            await delay(Math.min(50, deadline - Date.now()), undefined, { signal });
            signal.throwIfAborted();
            next = lease.renew ? lease.renew(options.estimatedTokens || 0) : lease;
          }
          if (!next) throw new Error('当前任务绑定端点暂不可用，任务未切换端点。');
          current = next;

          return { ...next, next: undefined };
        }
        const selected = await getChatCredentials({ ...options, signal });

        if (signal.aborted) {
          selected?.report?.({ ok: false, errorKind: 'cancelled' });
          signal.throwIfAborted();
        }
        lease = selected;
        lease?.hold?.();
        current = lease;

        return lease ? wrapInitial(lease) : null;
      } finally {
        acquiring = false;
      }
    },
    close() {
      lifetime.abort(new Error('任务绑定已释放'));
      current?.report?.({ ok: false, errorKind: 'cancelled' });
      lease?.endTask?.();
    }
  };
};
