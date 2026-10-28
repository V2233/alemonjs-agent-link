// Model endpoint pool configuration. Kept dependency-free so both the config
// reader and the credential runtime can validate the same shape.
export type ModelPoolPurpose = 'chat' | 'tools' | 'vision' | 'replyGate';
export type ModelPoolStrategy = 'weighted-round-robin' | 'least-busy' | 'sticky';

export type ModelPoolEndpoint = {
  id: string;
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  weight: number;
  maxConcurrent: number;
  capabilities: ModelPoolPurpose[];
  enabled: boolean;
};

export type ModelPoolConfig = {
  enabled: boolean;
  strategy: ModelPoolStrategy;
  maxAttempts: number;
  failureThreshold: number;
  cooldownSeconds: number;
  retryStatuses: number[];
  endpoints: ModelPoolEndpoint[];
};

export type ModelPoolDefaults = {
  provider: string;
  baseUrl?: string;
  model: string;
  apiKey?: string;
};

const idPattern = /^[a-z][a-z0-9-]{0,39}$/u;
const purposes = new Set<ModelPoolPurpose>(['chat', 'tools', 'vision', 'replyGate']);
const strategies = new Set<ModelPoolStrategy>(['weighted-round-robin', 'least-busy', 'sticky']);
const defaultRetryStatuses = [401, 402, 403, 429, 500, 502, 503, 504];

const text = (value: unknown, name: string, max: number): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\r\n\0]/u.test(value)) {
    throw new Error(`modelPool ${name} 无效。`);
  }

  return value.trim();
};

const integer = (value: unknown, name: string, min: number, max: number): number => {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) {
    throw new Error(`modelPool ${name} 需要 ${min}–${max} 的整数。`);
  }

  return Number(value);
};

const httpsUrl = (value: string, name: string): string => {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error(`modelPool ${name} 不是有效 URL。`);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error(`modelPool ${name} 需要不含凭证、查询参数的 HTTPS 地址。`);
  }

  return value.replace(/\/+$/u, '');
};

const endpointKey = (raw: Record<string, unknown>): string => {
  const direct = typeof raw.apiKey === 'string' ? raw.apiKey.trim() : '';
  const envName = typeof raw.apiKeyEnv === 'string' ? raw.apiKeyEnv.trim() : '';

  if (direct && envName) throw new Error('modelPool 端点不能同时配置 apiKey 和 apiKeyEnv。');
  if (envName) {
    const value = process.env[envName];

    if (!value) throw new Error(`modelPool 端点 ${String(raw.id || '')} 的 apiKeyEnv ${envName} 未设置。`);

    return value.trim();
  }

  return direct;
};

export const parseModelPool = (raw: unknown, defaults: ModelPoolDefaults): ModelPoolConfig | undefined => {
  if (raw === undefined || raw === null || raw === false) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('modelPool 需要为对象。');
  const value = raw as Record<string, unknown>;

  if (value.enabled === false) return undefined;
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') throw new Error('modelPool.enabled 需要为布尔值。');
  if (!Array.isArray(value.endpoints) || value.endpoints.length === 0) return undefined;
  if (value.endpoints.length > 20) throw new Error('modelPool.endpoints 最多 20 个。');

  const ids = new Set<string>();
  const endpoints = value.endpoints.map((entry, index): ModelPoolEndpoint => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`modelPool.endpoints[${index}] 需要为对象。`);
    const item = entry as Record<string, unknown>;
    const id = text(item.id, `endpoints[${index}].id`, 40);

    if (!idPattern.test(id) || ids.has(id)) throw new Error(`modelPool 端点 id 无效或重复：${id}`);
    ids.add(id);
    const provider = item.provider === undefined ? defaults.provider : text(item.provider, `endpoints[${index}].provider`, 80);
    const fallbackBase = defaults.baseUrl || (provider === 'deepseek-official' ? 'https://api.deepseek.com' : '');
    const baseUrl = httpsUrl(item.baseUrl === undefined ? fallbackBase : text(item.baseUrl, `endpoints[${index}].baseUrl`, 500), `endpoints[${index}].baseUrl`);
    const apiKey = endpointKey(item);
    const model = text(item.model === undefined ? defaults.model : item.model, `endpoints[${index}].model`, 200);
    const weight = item.weight === undefined ? 1 : integer(item.weight, `endpoints[${index}].weight`, 1, 100);
    const maxConcurrent = item.maxConcurrent === undefined ? 2 : integer(item.maxConcurrent, `endpoints[${index}].maxConcurrent`, 1, 100);
    const capabilities = item.capabilities === undefined ? (['chat', 'tools', 'replyGate'] as ModelPoolPurpose[]) : item.capabilities;

    if (
      !Array.isArray(capabilities) ||
      capabilities.length === 0 ||
      capabilities.length > purposes.size ||
      capabilities.some(capability => typeof capability !== 'string' || !purposes.has(capability as ModelPoolPurpose))
    ) {
      throw new Error(`modelPool.endpoints[${index}].capabilities 无效。`);
    }
    if (typeof item.enabled !== 'undefined' && typeof item.enabled !== 'boolean') throw new Error(`modelPool.endpoints[${index}].enabled 需要为布尔值。`);
    if (!apiKey || apiKey.length < 8 || apiKey.length > 500) throw new Error(`modelPool 端点 ${id} 的 apiKey 无效。`);

    return {
      id,
      provider,
      baseUrl,
      apiKey,
      model,
      weight,
      maxConcurrent,
      capabilities: [...new Set(capabilities as ModelPoolPurpose[])],
      enabled: item.enabled !== false
    };
  });
  const strategy = value.strategy === undefined ? 'weighted-round-robin' : value.strategy;

  if (typeof strategy !== 'string' || !strategies.has(strategy as ModelPoolStrategy)) throw new Error('modelPool.strategy 无效。');
  const retryStatuses = value.retryStatuses === undefined ? defaultRetryStatuses : value.retryStatuses;

  if (
    !Array.isArray(retryStatuses) ||
    retryStatuses.length > 20 ||
    retryStatuses.some(status => !Number.isSafeInteger(status) || status < 100 || status > 599)
  ) {
    throw new Error('modelPool.retryStatuses 无效。');
  }

  return {
    enabled: true,
    strategy: strategy as ModelPoolStrategy,
    maxAttempts: value.maxAttempts === undefined ? 3 : integer(value.maxAttempts, 'maxAttempts', 1, 5),
    failureThreshold: value.failureThreshold === undefined ? 2 : integer(value.failureThreshold, 'failureThreshold', 1, 10),
    cooldownSeconds: value.cooldownSeconds === undefined ? 60 : integer(value.cooldownSeconds, 'cooldownSeconds', 1, 86400),
    retryStatuses: [...new Set(retryStatuses as number[])],
    endpoints
  };
};

export const modelPoolFingerprint = (pool: ModelPoolConfig | undefined): string => (pool ? JSON.stringify(pool) : '');
