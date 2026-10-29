import type { ModelPoolStatus } from '@src/credentials/pool';
import type { EndpointBalance } from '@src/model-pool/balance';
import type { BridgeMetrics } from '@src/model-pool/bridge-metrics';

export const POOL_PAGE_SIZE = 5;

const seconds = (value: number): string => (value >= 60 ? `${Math.ceil(value / 60)} 分钟` : `${Math.max(0, Math.ceil(value))} 秒`);

const relativeProbe = (lastProbeAt: number, now: number): string => {
  if (!lastProbeAt) return '未探测';
  const elapsed = Math.max(0, Math.round((now - lastProbeAt) / 1000));

  return elapsed < 2 ? '刚刚' : `${seconds(elapsed)}前`;
};

const stateText = (item: ModelPoolStatus, now: number): string => {
  if (item.disabled) {
    if (!Number.isFinite(item.disabledUntil)) return '停用（手动）';

    return item.disabledUntil > now ? `停用，${seconds((item.disabledUntil - now) / 1000)}后重试` : '停用';
  }
  if (item.cooldownUntil > now) return `冷却 ${seconds((item.cooldownUntil - now) / 1000)}`;
  if (item.healthy === false) return '探测异常';
  if (item.healthy === undefined) return '未知';

  return '正常';
};

export type PoolRow = {
  number: number;
  id: string;
  provider: string;
  model: string;
  disabled: boolean;
  detail: string;
};

export type PoolPageView = {
  page: number;
  pages: number;
  total: number;
  available: number;
  cooling: number;
  disabled: number;
  abnormal: number;
  inFlight: number;
  probeCount: number;
  vision: number;
  fallback: number;
  balanceCount: number;
  balanceTotal?: number;
  usedTotal?: number;
  usedCount: number;
  lowBalance: number;
  sandboxRequests: number;
  sandboxTokens: number;
  personalSandboxRequests: number;
  personalSandboxTokens: number;
  needsRefill: boolean;
  rows: PoolRow[];
  text: string;
};

export const poolPageView = (
  items: (ModelPoolStatus & { lastProbeAt?: number; lastStatus?: number })[],
  requestedPage: number,
  now = Date.now(),
  balances: Map<string, EndpointBalance> = new Map(),
  lowBalanceThreshold = 5,
  bridge: BridgeMetrics | null = null
): PoolPageView => {
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / POOL_PAGE_SIZE));
  const page = Math.min(Math.max(1, Math.trunc(requestedPage) || 1), pages);
  const disabled = items.filter(item => item.disabled).length;
  const cooling = items.filter(item => !item.disabled && item.cooldownUntil > now).length;
  const available = items.filter(item => !item.disabled && item.cooldownUntil <= now).length;
  const abnormal = items.filter(item => !item.disabled && item.cooldownUntil <= now && item.healthy === false).length;
  const inFlight = items.reduce((sum, item) => sum + item.active, 0);
  const probeCount = items.filter(item => (item.lastProbeAt || 0) > 0).length;
  const vision = items.filter(item => item.capabilities.includes('vision')).length;
  const fallback = items.filter(item => item.fallback).length;
  const known = items.map(item => balances.get(item.id)).filter((item): item is EndpointBalance => item?.amount !== undefined);
  const balanceTotal = known.length ? known.reduce((sum, item) => sum + (item.amount || 0), 0) : undefined;
  const usedByAccount = new Map<string, EndpointBalance>();

  for (const item of items) {
    const balance = balances.get(item.id);

    if (balance?.used !== undefined) usedByAccount.set(item.account || item.id, balance);
  }

  const usedTotal = usedByAccount.size ? [...usedByAccount.values()].reduce((sum, item) => sum + (item.used || 0), 0) : undefined;
  const lowBalance = known.filter(item => (item.amount || 0) < lowBalanceThreshold).length;
  const sandboxUsage = items.map(item => bridge?.endpoints[item.id]).filter(Boolean);
  const sandboxRequests = sandboxUsage.reduce((sum, item) => sum + (item?.requests || 0), 0);
  const sandboxTokens = sandboxUsage.reduce((sum, item) => sum + (item?.input || 0) + (item?.output || 0), 0);
  const personalSandboxRequests = bridge?.personal.requests || 0;
  const personalSandboxTokens = (bridge?.personal.input || 0) + (bridge?.personal.output || 0);
  const needsRefill = available <= 1 || disabled > 0;
  const hint =
    lowBalance > 0
      ? `有 ${lowBalance} 个端点余额低于 ¥${lowBalanceThreshold}，建议及时补货。`
      : available <= 1
        ? `可用端点只剩 ${available} 个，建议立即补货或换 Key。`
        : disabled > 0
          ? `有 ${disabled} 个端点停用，可用 ${available} 个；需要补货时先换 Key 或补余额。`
          : cooling > 0
            ? `${cooling} 个端点冷却中；若持续出现，建议补货。`
            : '池状态正常。';
  const lines = [
    `额度轮转 ${page}/${pages}`,
    `总数 ${total} · 可用 ${available} · 冷却 ${cooling} · 停用 ${disabled} · 异常 ${abnormal} · 在途 ${inFlight}`,
    `探测 ${probeCount}/${total} · 视觉 ${vision} · 备用 ${fallback} · 沙箱 ${sandboxRequests} 次/${sandboxTokens} tok · 个人/群 ${personalSandboxRequests} 次/${personalSandboxTokens} tok · 余额 ${balanceTotal === undefined ? '未知' : `¥${balanceTotal.toFixed(2)}（${known.length}/${total}）`} · 已用 ${usedTotal === undefined ? '未知' : `¥${usedTotal.toFixed(2)}（${usedByAccount.size}/${total}）`} · 低余额 ${lowBalance} · 补货提示：${hint}`,
    ''
  ];
  const start = (page - 1) * POOL_PAGE_SIZE;
  const visible = items.slice(start, start + POOL_PAGE_SIZE);
  const rows: PoolRow[] = [];

  if (visible.length === 0) {
    lines.push('没有端点。');
  } else {
    for (const [offset, item] of visible.entries()) {
      const number = start + offset + 1;
      const state = stateText(item, now);
      const detail = [
        `状态 ${state}`,
        item.lastRequest
          ? `最近调用 ${item.lastRequest.ok ? '成功' : '失败'} · ${new Date(item.lastRequest.at).toLocaleString()}${item.lastRequest.status ? ` · HTTP ${item.lastRequest.status}` : ''}`
          : '暂无调用记录',
        `提供方 ${item.provider} · 模型 ${item.model}`,
        `全部尝试（含门控） ${item.totalCalls ?? 0} · 成功 ${item.successfulCalls ?? 0} · 失败 ${item.failedCalls ?? 0}`,
        `其中门控 ${item.purposeStatistics?.replyGate?.total ?? 0} · 成功 ${item.purposeStatistics?.replyGate?.success ?? 0} · 失败 ${item.purposeStatistics?.replyGate?.failed ?? 0}`,
        `未结算 ${Math.max(0, (item.totalCalls ?? 0) - (item.successfulCalls ?? 0) - (item.failedCalls ?? 0))}`,
        `在途 ${item.active}/${item.maxConcurrent}`,
        `绑定 ${item.bound}`,
        `近期 ${item.recent}`,
        item.capabilityProbed ? `验证 ${item.verified.length ? item.verified.join('/') : '无'}` : '未验证',
        `今日 ${item.dailyRequests} 次 / ${item.dailyTokens} tok`,
        bridge?.endpoints[item.id]
          ? `沙箱 ${bridge.endpoints[item.id].requests} 次 / ${bridge.endpoints[item.id].input + bridge.endpoints[item.id].output} tok`
          : '',
        item.latencyMs > 0 ? `延迟 ${item.latencyMs}ms` : '延迟未知',
        `探测 ${relativeProbe(item.lastProbeAt || 0, now)}`,
        item.rpm ? `RPM ${item.requests}/${item.rpm}` : '',
        item.tpm ? `TPM ${item.tokens}/${item.tpm}` : '',
        item.lastStatus ? `HTTP ${item.lastStatus}` : '无 HTTP 状态',
        item.failures > 0 ? `失败 ${item.failures}` : '',
        item.fallback ? '备用' : '',
        item.capabilities.includes('vision') ? '视觉' : '',
        balances.get(item.id) ? (balances.get(item.id)?.used !== undefined ? balances.get(item.id)?.text : `余额 ${balances.get(item.id)?.text}`) : '余额未查'
      ].filter(Boolean);

      lines.push(`${number}. ${item.id} · ${item.provider} · ${item.model}`, `   ${detail.join(' · ')}`);
      rows.push({ number, id: item.id, provider: item.provider, model: item.model, disabled: item.disabled, detail: detail.join('\n') });
    }
  }

  return {
    page,
    pages,
    total,
    available,
    cooling,
    disabled,
    abnormal,
    inFlight,
    probeCount,
    vision,
    fallback,
    balanceCount: known.length,
    balanceTotal,
    usedTotal,
    usedCount: usedByAccount.size,
    lowBalance,
    sandboxRequests,
    sandboxTokens,
    personalSandboxRequests,
    personalSandboxTokens,
    needsRefill,
    rows,
    text: lines.join('\n')
  };
};
