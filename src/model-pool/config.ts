// Model endpoint pool configuration. Kept dependency-free so both the config
// reader and the credential runtime can validate the same shape.
export type ModelPoolPurpose = 'chat' | 'tools' | 'vision' | 'replyGate';
export type ModelPoolStrategy = 'weighted-round-robin' | 'least-busy' | 'balanced' | 'sticky';

export type ModelPoolEndpoint = {
  id: string;
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  fallback?: boolean;
  priority: number;
  workspace?: boolean;
  account?: string;
  rpm?: number;
  tpm?: number;
  balanceUrl?: string;
  balanceStyle?: 'newapi';
  pricing?: { input: number; output: number; cached: number };
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
  probeIntervalSeconds: number;
  probeTimeoutMs: number;
  probeChat: boolean;
  capabilityProbe: boolean;
  capabilityProbeTimeoutMs: number;
  recoveryProbeSeconds: number;
  stickySeconds: number;
  balanceWindowSeconds: number;
  retryBudgetMs: number;
  retryJitterMs: number;
  queueMaxWaitMs: number;
  balanceStyle?: 'newapi';
  balanceUrl?: string;
  balanceUrls?: Record<string, string>;
  balanceAlertYuan: number;
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
const strategies = new Set<ModelPoolStrategy>(['weighted-round-robin', 'least-busy', 'balanced', 'sticky']);
const defaultRetryStatuses = [401, 402, 403, 404, 405, 429, 500, 502, 503, 504];

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

const balanceStyle = (raw: unknown, name: string): 'newapi' | undefined => {
  if (raw === undefined) return undefined;
  if (raw !== 'newapi') throw new Error(`${name} 只支持 newapi。`);

  return raw;
};

const balanceConfig = (raw: unknown): { balanceUrl?: string; balanceUrls?: Record<string, string> } => {
  if (raw === undefined) return {};
  if (typeof raw === 'string') return { balanceUrl: balanceTemplate(raw, 'modelPool.balanceUrl') };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('modelPool.balanceUrl 需要为 URL 字符串或按 provider 映射的对象。');
  const entries = Object.entries(raw as Record<string, unknown>);

  if (entries.length === 0 || entries.length > 20) throw new Error('modelPool.balanceUrl 的 provider 映射需要 1–20 项。');
  const balanceUrls: Record<string, string> = {};

  for (const [provider, value] of entries) {
    if (!provider.trim() || provider.length > 80) throw new Error('modelPool.balanceUrl 的 provider 名无效。');
    balanceUrls[provider] = balanceTemplate(value, `modelPool.balanceUrl.${provider}`);
  }

  return { balanceUrls };
};

const balanceTemplate = (raw: unknown, name: string): string => {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 1000) throw new Error(`${name} 需要为 URL 字符串。`);
  const value = raw.trim();

  if (!value.includes('{key}')) throw new Error(`${name} 必须包含 {key} 占位符。`);
  let url: URL;

  try {
    url = new URL(value.replaceAll('{key}', 'sk-test-00000000'));
  } catch {
    throw new Error(`${name} 不是有效 URL。`);
  }
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error(`${name} 需要不含凭证的 HTTPS 地址。`);

  return value;
};

const parsePricing = (raw: unknown, index: number): { input: number; output: number; cached: number } => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`modelPool.endpoints[${index}].pricing 无效。`);
  const value = raw as Record<string, unknown>;
  const price = (key: string): number => {
    const item = value[key];

    if (typeof item !== 'number' || !Number.isFinite(item) || item < 0 || item > 100000) {
      throw new Error(`modelPool.endpoints[${index}].pricing.${key} 需要为非负数字。`);
    }

    return item;
  };

  return { input: price('input'), output: price('output'), cached: value.cached === undefined ? 0 : price('cached') };
};

const normalizeKeys = (raw: Record<string, unknown>): unknown[] | undefined => {
  if (raw.keys === undefined) return undefined;
  if (raw.endpoints !== undefined) throw new Error('modelPool 不能同时配置 keys 和 endpoints。');
  if (!Array.isArray(raw.keys) || raw.keys.length === 0) return undefined;
  if (raw.keys.length > 20) throw new Error('modelPool.keys 最多 20 个。');
  const shared = {
    ...(raw.provider === undefined ? {} : { provider: raw.provider }),
    ...(raw.baseUrl === undefined ? {} : { baseUrl: raw.baseUrl }),
    ...(raw.model === undefined ? {} : { model: raw.model })
  };

  return raw.keys.map((entry, index) => {
    if (typeof entry === 'string') return { ...shared, id: `key-${index + 1}`, apiKey: entry };
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`modelPool.keys[${index}] 需要为 Key 字符串或对象。`);
    const item = entry as Record<string, unknown>;
    const key = item.apiKey === undefined ? item.key : item.apiKey;

    if (item.key !== undefined && item.apiKey !== undefined) throw new Error(`modelPool.keys[${index}] 不能同时配置 key 和 apiKey。`);

    return {
      ...shared,
      ...item,
      ...(key === undefined ? {} : { apiKey: key }),
      ...(item.api === undefined ? {} : { baseUrl: item.baseUrl === undefined ? item.api : item.baseUrl }),
      id: item.id === undefined ? `key-${index + 1}` : item.id
    };
  });
};

export const parseModelPool = (raw: unknown, defaults: ModelPoolDefaults): ModelPoolConfig | undefined => {
  if (raw === undefined || raw === null || raw === false) return undefined;
  if (Array.isArray(raw)) raw = { keys: raw };
  if (!raw || typeof raw !== 'object') throw new Error('modelPool 需要为对象或 Key 数组。');
  const value = raw as Record<string, unknown>;

  if (value.enabled === false) return undefined;
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') throw new Error('modelPool.enabled 需要为布尔值。');
  if (value.probeChat !== undefined && typeof value.probeChat !== 'boolean') throw new Error('modelPool.probeChat 需要为布尔值。');
  if (value.capabilityProbe !== undefined && typeof value.capabilityProbe !== 'boolean') throw new Error('modelPool.capabilityProbe 需要为布尔值。');
  const keys = normalizeKeys(value);
  const source = keys === undefined ? value.endpoints : keys;

  if (!Array.isArray(source) || source.length === 0) return undefined;
  // if (source.length > 50) throw new Error('modelPool.endpoints 最多 20 个。');

  const ids = new Set<string>();
  const endpoints = source.map((entry, index): ModelPoolEndpoint => {
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
    const pricing = item.pricing === undefined ? undefined : parsePricing(item.pricing, index);

    if (item.fallback !== undefined && typeof item.fallback !== 'boolean') throw new Error(`modelPool.endpoints[${index}].fallback 需要为布尔值。`);
    const priority = index; // Array order is the sole source of priority.
    const endpointBalanceStyle = balanceStyle(item.balanceStyle, `endpoints[${index}].balanceStyle`);
    const account = item.account === undefined ? undefined : text(item.account, `endpoints[${index}].account`, 80);

    if (item.workspace !== undefined && typeof item.workspace !== 'boolean') throw new Error(`modelPool.endpoints[${index}].workspace 需要为布尔值。`);
    const rpm = item.rpm === undefined ? undefined : integer(item.rpm, `endpoints[${index}].rpm`, 1, 1000000);
    const tpm = item.tpm === undefined ? undefined : integer(item.tpm, `endpoints[${index}].tpm`, 1, 1000000000);
    const balanceUrl = item.balanceUrl === undefined ? undefined : balanceTemplate(item.balanceUrl, `endpoints[${index}].balanceUrl`);
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
      ...(pricing ? { pricing } : {}),
      ...(item.fallback === true ? { fallback: true } : {}),
      priority,
      ...(endpointBalanceStyle ? { balanceStyle: endpointBalanceStyle } : {}),
      ...(account ? { account } : {}),
      ...(item.workspace === true ? { workspace: true } : {}),
      ...(rpm ? { rpm } : {}),
      ...(tpm ? { tpm } : {}),
      ...(balanceUrl ? { balanceUrl } : {}),
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

  const balance = balanceConfig(value.balanceUrl === undefined ? value.balanceUrls : value.balanceUrl);
  const poolBalanceStyle = balanceStyle(value.balanceStyle, 'modelPool.balanceStyle');

  return {
    enabled: true,
    strategy: strategy as ModelPoolStrategy,
    maxAttempts: value.maxAttempts === undefined ? 3 : integer(value.maxAttempts, 'maxAttempts', 1, 20),
    failureThreshold: value.failureThreshold === undefined ? 2 : integer(value.failureThreshold, 'failureThreshold', 1, 10),
    cooldownSeconds: value.cooldownSeconds === undefined ? 60 : integer(value.cooldownSeconds, 'cooldownSeconds', 1, 86400),
    retryStatuses: [...new Set(retryStatuses as number[])],
    probeIntervalSeconds: value.probeIntervalSeconds === undefined ? 60 : integer(value.probeIntervalSeconds, 'probeIntervalSeconds', 0, 3600),
    probeTimeoutMs: value.probeTimeoutMs === undefined ? 5000 : integer(value.probeTimeoutMs, 'probeTimeoutMs', 1000, 30000),
    probeChat: value.probeChat === undefined ? true : value.probeChat === true,
    capabilityProbe: value.capabilityProbe === true,
    capabilityProbeTimeoutMs:
      value.capabilityProbeTimeoutMs === undefined ? 60000 : integer(value.capabilityProbeTimeoutMs, 'capabilityProbeTimeoutMs', 5000, 120000),
    recoveryProbeSeconds: value.recoveryProbeSeconds === undefined ? 300 : integer(value.recoveryProbeSeconds, 'recoveryProbeSeconds', 0, 86400),
    stickySeconds: value.stickySeconds === undefined ? 1800 : integer(value.stickySeconds, 'stickySeconds', 0, 86400),
    balanceWindowSeconds: value.balanceWindowSeconds === undefined ? 300 : integer(value.balanceWindowSeconds, 'balanceWindowSeconds', 0, 86400),
    retryBudgetMs: value.retryBudgetMs === undefined ? 12000 : integer(value.retryBudgetMs, 'retryBudgetMs', 1000, 300000),
    retryJitterMs: value.retryJitterMs === undefined ? 200 : integer(value.retryJitterMs, 'retryJitterMs', 0, 5000),
    queueMaxWaitMs: value.queueMaxWaitMs === undefined ? 0 : integer(value.queueMaxWaitMs, 'queueMaxWaitMs', 0, 30000),
    ...balance,
    ...(poolBalanceStyle ? { balanceStyle: poolBalanceStyle } : {}),
    balanceAlertYuan: value.balanceAlertYuan === undefined ? 5 : integer(value.balanceAlertYuan, 'balanceAlertYuan', 0, 1000000),
    endpoints
  };
};

export const modelPoolFingerprint = (pool: ModelPoolConfig | undefined): string => (pool ? JSON.stringify(pool) : '');
