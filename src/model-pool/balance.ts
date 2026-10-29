import type { ModelPoolConfig, ModelPoolEndpoint } from './config';

export type EndpointBalance = {
  text: string;
  amount?: number;
  used?: number;
  currency?: string;
  checkedAt: number;
  status?: 'normal' | 'exhausted' | 'rate-limited' | 'frozen' | 'invalid' | 'forbidden' | 'unavailable' | 'unsupported' | 'failed' | 'unknown';
  httpStatus?: number;
};

type CacheEntry = EndpointBalance & { expiresAt: number };
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, CacheEntry>();

const numberValue = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);

  return undefined;
};

const money = (amount: number, currency = 'CNY'): string => `${currency === 'CNY' ? '¥' : `${currency} `}${amount.toFixed(2)}`;

export const balanceFailure = async (response: Response): Promise<EndpointBalance> => {
  let evidence = '';

  try {
    const body = (await response.json()) as { error?: { code?: unknown; message?: unknown }; code?: unknown; message?: unknown };

    evidence = String(body.error?.code || body.code || '') + ' ' + String(body.error?.message || body.message || '');
  } catch {
    /* status still available */
  }
  const status: EndpointBalance['status'] = /frozen|account_frozen|账户冻结|账号冻结/i.test(evidence)
    ? 'frozen'
    : response.status === 429
      ? 'rate-limited'
      : response.status === 401
        ? 'invalid'
        : response.status === 402
          ? 'exhausted'
          : response.status === 403
            ? 'forbidden'
            : 'failed';
  const labels = { frozen: '账户冻结', 'rate-limited': '供应商限流', invalid: '凭证无效', exhausted: '额度不足', forbidden: '访问受限', failed: '查询失败' };

  return { status, text: labels[status], httpStatus: response.status, checkedAt: Date.now() };
};
const deepSeekBalance = async (endpoint: ModelPoolEndpoint, signal: AbortSignal): Promise<EndpointBalance | null> => {
  const base = endpoint.baseUrl.replace(/\/+$/u, '').replace(/\/v1$/u, '');
  const response = await fetch(`${base}/user/balance`, {
    headers: { Authorization: `Bearer ${endpoint.apiKey}`, Accept: 'application/json' },
    redirect: 'error',
    signal
  });

  if (!response.ok) return balanceFailure(response);
  const payload = (await response.json()) as { is_available?: unknown; balance_infos?: Array<{ currency?: unknown; total_balance?: unknown }> };
  const info = payload.balance_infos?.find(item => item.currency === 'CNY') || payload.balance_infos?.[0];
  const amount = numberValue(info?.total_balance);

  if (amount === undefined) return null;

  return {
    status: amount <= 0 ? 'exhausted' : payload.is_available === false ? 'unavailable' : 'normal',
    text:
      payload.is_available === false
        ? `不可用（${money(amount, typeof info?.currency === 'string' ? info.currency : 'CNY')}）`
        : money(amount, typeof info?.currency === 'string' ? info.currency : 'CNY'),
    amount,
    currency: typeof info?.currency === 'string' ? info.currency : 'CNY',
    checkedAt: Date.now()
  };
};

const newApiBalance = async (endpoint: ModelPoolEndpoint, signal: AbortSignal): Promise<EndpointBalance | null> => {
  const base = endpoint.baseUrl.replace(/\/+$/u, '');
  const headers = { Authorization: `Bearer ${endpoint.apiKey}`, Accept: 'application/json' };
  const usage = await fetch(`${base}/dashboard/billing/usage`, { headers, redirect: 'error', signal });

  if (!usage.ok) return balanceFailure(usage);
  const payload = (await usage.json()) as { total_usage?: unknown };
  const cents = numberValue(payload.total_usage);

  if (cents === undefined) return null;
  const used = Math.max(0, cents / 100);

  return { text: `已用 ¥${used.toFixed(2)}`, used, currency: 'CNY', checkedAt: Date.now() };
};

const templateBalance = async (endpoint: ModelPoolEndpoint, template: string, signal: AbortSignal): Promise<EndpointBalance | null> => {
  const url = template.replaceAll('{key}', encodeURIComponent(endpoint.apiKey));
  const response = await fetch(url, { headers: { Accept: 'application/json' }, redirect: 'error', signal });

  if (response.status === 404) return { text: '未收录', checkedAt: Date.now() };
  if (!response.ok) return balanceFailure(response);
  const payload = (await response.json()) as Record<string, unknown>;

  if (payload.ok === false) return { text: '未收录', checkedAt: Date.now() };
  const data = (payload.data && typeof payload.data === 'object' ? payload.data : payload) as Record<string, unknown>;
  const vouchers = Array.isArray(data.vouchers) ? data.vouchers : [];
  const voucherTotal = vouchers.reduce((sum, voucher) => {
    const item = voucher && typeof voucher === 'object' ? (voucher as Record<string, unknown>) : {};

    return sum + (numberValue(item.available) || 0);
  }, 0);
  const amount = numberValue(data.total_available) ?? numberValue(data.balance) ?? (vouchers.length ? voucherTotal : undefined);

  if (amount === undefined) return { text: '无余额字段', checkedAt: Date.now() };

  return { status: amount <= 0 ? 'exhausted' : 'normal', text: money(amount), amount, currency: 'CNY', checkedAt: Date.now() };
};

const fetchOne = async (config: ModelPoolConfig, endpoint: ModelPoolEndpoint, force = false): Promise<EndpointBalance | null> => {
  const template = endpoint.balanceUrl || config.balanceUrls?.[endpoint.provider] || (endpoint.provider === 'sensenova' ? undefined : config.balanceUrl);
  const style = endpoint.balanceStyle || config.balanceStyle;
  const cacheKey = `${endpoint.id}:${endpoint.apiKey.slice(-6)}:${style || ''}:${template || ''}`;
  const cached = cache.get(cacheKey);

  if (!force && cached && cached.expiresAt > Date.now()) return cached;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);

  timer.unref?.();

  try {
    let result: EndpointBalance | null = null;

    if (endpoint.provider === 'deepseek-official' && /(^|\.)api\.deepseek\.com$/u.test(new URL(endpoint.baseUrl).hostname)) {
      result = await deepSeekBalance(endpoint, controller.signal);
    }
    if (!result && style === 'newapi') result = await newApiBalance(endpoint, controller.signal);
    if (!result && template) result = await templateBalance(endpoint, template, controller.signal);
    if (!result && endpoint.provider === 'sensenova') result = { text: '免费/限流', checkedAt: Date.now() };
    if (!result) result = { status: 'unsupported', text: '无余额接口', checkedAt: Date.now() };

    cache.set(cacheKey, { ...result, expiresAt: Date.now() + CACHE_TTL_MS });

    return result;
  } catch {
    return { status: 'failed', text: '查询失败', checkedAt: Date.now() };
  } finally {
    clearTimeout(timer);
  }
};

export const fetchPoolBalances = async (config: ModelPoolConfig, force = false, endpointId?: string): Promise<Map<string, EndpointBalance>> => {
  const rows = await Promise.all(
    config.endpoints
      .filter(endpoint => !endpointId || endpoint.id === endpointId)
      .map(async endpoint => [endpoint.id, await fetchOne(config, endpoint, force)] as const)
  );

  return new Map(rows);
};

export const clearBalanceCache = (): void => cache.clear();
