import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { endpointObservation } from './pool-observation';
import { readReplyGateStatistics } from '../social/reply-gate-statistics';
import { getDSHConfig } from '../dsh/runtime-config';
import { CredentialPool, getCredentialPool } from '../credentials/pool';
import { getAppConfig } from 'alemonjs';
import { fetchPoolBalances } from '../model-pool/balance';
import { readBridgeMetrics } from '../model-pool/bridge-metrics';

let diagnostics: { fingerprint: string; pool: CredentialPool } | undefined;
// An isolated, unscheduled pool keeps diagnostics available while rotation is off.
// It never replaces or enables the pool used by business requests.
const diagnosticPool = () => {
  const active = getCredentialPool(getDSHConfig());

  if (active) {
    diagnostics?.pool.stop();
    diagnostics = undefined;

    return active;
  }
  const app = getAppConfig<Record<string, any>>().value;
  const raw = app.modelPool;
  const config = raw && getDSHConfig({ ...app, modelPool: { ...(Array.isArray(raw) ? { keys: raw } : raw), enabled: true } }).modelPool;

  if (!config) {
    diagnostics?.pool.stop();
    diagnostics = undefined;

    return null;
  }
  const fingerprint = JSON.stringify(config);

  if (diagnostics?.fingerprint !== fingerprint) {
    diagnostics?.pool.stop();
    diagnostics = { fingerprint, pool: new CredentialPool(config, Date.now, join(dirname(getDSHConfig().dshHomeRoot), 'model-pool-metrics.json'), true) };
  }

  return diagnostics.pool;
};

let balanceSnapshot: { fingerprint: string; checkedAt: number; refreshing: boolean; values: Record<string, unknown> } | undefined;
const automaticBalances = (pool: CredentialPool | null) => {
  if (!pool) return undefined;
  const fingerprint = createHash('sha256').update(JSON.stringify(pool.config)).digest('hex');

  if (balanceSnapshot?.fingerprint !== fingerprint) balanceSnapshot = { fingerprint, checkedAt: 0, refreshing: false, values: {} };
  const snapshot = balanceSnapshot;

  if (!snapshot.refreshing && Date.now() - snapshot.checkedAt >= 60000) {
    snapshot.refreshing = true;
    void fetchPoolBalances(pool.config)
      .then(values => {
        snapshot.values = Object.fromEntries(values);
      })
      .catch(() => undefined)
      .finally(() => {
        snapshot.checkedAt = Date.now();
        snapshot.refreshing = false;
      });
  }

  return snapshot;
};

export const poolSnapshot = async () => {
  const config = getDSHConfig();
  const pool = getCredentialPool(config);
  const inspected = pool || diagnosticPool();
  const balances = automaticBalances(inspected);

  return {
    replyGateStatistics: readReplyGateStatistics(config),
    probeRun: getPoolProbeRun(),
    healthRun: getPoolHealthRun(),
    sampledAt: Date.now(),
    enabled: Boolean(pool),
    strategy: pool?.config.strategy,
    balanceAlertYuan: pool?.config.balanceAlertYuan,
    balances: balances?.values || {},
    balancesRefreshing: balances?.refreshing || false,
    endpoints: inspected?.status.map(endpoint => ({ ...endpoint, ...endpointObservation(endpoint) })) ?? [],
    bridge: await readBridgeMetrics(config),
    budget: config.budget ?? { enabled: false }
  };
};
export const poolBalances = async (id?: string) => {
  const pool = diagnosticPool();

  if (id && !pool?.status.some(item => item.id === id)) throw new Error('端点不存在');

  const result = pool ? Object.fromEntries(await fetchPoolBalances(pool.config, true, id)) : {};

  if (balanceSnapshot && pool) {
    balanceSnapshot.values = { ...balanceSnapshot.values, ...result };
    if (!id) balanceSnapshot.checkedAt = Date.now();
  }

  return result;
};
export const poolAction = async (id: unknown, action: unknown) => {
  if (typeof id !== 'string' || !['enable', 'disable', 'probe', 'health-check'].includes(String(action))) throw new Error('无效的端点操作');
  const pool = ['probe', 'health-check'].includes(String(action)) ? diagnosticPool() : getCredentialPool(getDSHConfig());

  if (!pool?.status.some(item => item.id === id)) throw new Error('端点不存在');
  const found =
    action === 'health-check'
      ? await pool.healthCheckEndpoint(id)
      : action === 'probe'
        ? await pool.probeEndpoint(id, false)
        : pool.setEndpointEnabled(id, action === 'enable');

  if (!found) throw new Error('端点操作失败');

  return poolSnapshot();
};

type ProbeResult = { id: string; state: 'pending' | 'running' | 'done' | 'failed' };
let probeRun: { running: boolean; startedAt: number; finishedAt?: number; results: ProbeResult[] } | undefined;

export const getPoolProbeRun = () => probeRun;
export const startPoolProbeRun = () => {
  if (probeRun?.running) return probeRun;
  const pool = diagnosticPool();

  if (!pool) throw new Error('未配置额度轮转');
  const run = {
    running: true,
    startedAt: Date.now(),
    finishedAt: undefined as number | undefined,
    results: pool.status.map((item): ProbeResult => ({ id: item.id, state: 'pending' }))
  };

  probeRun = run;
  void (async () => {
    try {
      for (let index = 0; index < run.results.length; index += 2) {
        await Promise.all(
          run.results.slice(index, index + 2).map(async item => {
            item.state = 'running';
            try {
              item.state = (await pool.probeEndpoint(item.id, false)) ? 'done' : 'failed';
            } catch {
              item.state = 'failed';
            }
          })
        );
      }
    } finally {
      run.running = false;
      run.finishedAt = Date.now();
    }
  })();

  return run;
};

type HealthRun = { running: boolean; startedAt: number; finishedAt?: number; results: ProbeResult[] };
let healthRun: HealthRun | undefined;

export const getPoolHealthRun = () => healthRun;
export const startPoolHealthRun = (): HealthRun => {
  if (healthRun?.running) return healthRun;
  const pool = diagnosticPool();

  if (!pool?.status.length) throw new Error('未配置额度轮转端点');
  const run: HealthRun = { running: true, startedAt: Date.now(), results: pool.status.map(item => ({ id: item.id, state: 'pending' })) };

  healthRun = run;
  void (async () => {
    try {
      for (let index = 0; index < run.results.length; index += 2) {
        await Promise.all(
          run.results.slice(index, index + 2).map(async item => {
            item.state = 'running';
            try {
              await pool.healthCheckEndpoint(item.id);
              item.state = pool.status.find(endpoint => endpoint.id === item.id)?.lastRequest?.ok === true ? 'done' : 'failed';
            } catch {
              item.state = 'failed';
            }
          })
        );
      }
    } finally {
      run.running = false;
      run.finishedAt = Date.now();
    }
  })();

  return run;
};
