import { getDSHConfig } from '../dsh/runtime-config';
import { getCredentialPool } from '../credentials/pool';
import { fetchPoolBalances } from '../model-pool/balance';
import { readBridgeMetrics } from '../model-pool/bridge-metrics';

export const poolSnapshot = async () => {
  const config = getDSHConfig();
  const pool = getCredentialPool(config);

  return {
    sampledAt: Date.now(),
    enabled: Boolean(pool),
    strategy: pool?.config.strategy,
    balanceAlertYuan: pool?.config.balanceAlertYuan,
    endpoints: pool?.status ?? [],
    bridge: await readBridgeMetrics(config),
    budget: config.budget ?? { enabled: false }
  };
};
export const poolBalances = async () => {
  const pool = getCredentialPool(getDSHConfig());

  return pool ? Object.fromEntries(await fetchPoolBalances(pool.config)) : {};
};
export const poolAction = async (id: unknown, action: unknown) => {
  if (typeof id !== 'string' || !['enable', 'disable', 'probe'].includes(String(action))) throw new Error('无效的端点操作');
  const pool = getCredentialPool(getDSHConfig());

  if (!pool?.status.some(item => item.id === id)) throw new Error('端点不存在');
  const found = action === 'probe' ? await pool.probeEndpoint(id, false) : pool.setEndpointEnabled(id, action === 'enable');

  if (!found) throw new Error('端点操作失败');

  return poolSnapshot();
};
