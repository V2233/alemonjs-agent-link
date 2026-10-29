import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DSHBridgeConfig } from '../dsh/config';

type GateStatistics = { total: number; success: number; failed: number; since: number; updatedAt: number };
const records = new Map<string, GateStatistics>();
const file = (config: DSHBridgeConfig) => join(dirname(config.workspaceRoot), 'reply-gate-statistics.json');

export const readReplyGateStatistics = (config: DSHBridgeConfig): GateStatistics => {
  const path = file(config);
  let value = records.get(path);

  if (!value) {
    value = { total: 0, success: 0, failed: 0, since: Date.now(), updatedAt: Date.now() };
    try {
      const stored = JSON.parse(readFileSync(path, 'utf8'));

      if (['total', 'success', 'failed', 'since', 'updatedAt'].every(key => Number.isSafeInteger(stored[key]) && stored[key] >= 0)) value = stored;
    } catch {
      /* Existing calls cannot be inferred from missing statistics. */
    }
    records.set(path, value);
  }

  return { ...value };
};
const persist = (config: DSHBridgeConfig, value: GateStatistics) => {
  const path = file(config);

  records.set(path, value);
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = path + '.' + process.pid + '.tmp';

    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    renameSync(temporary, path);
  } catch {
    /* Statistics persistence must not interrupt a model request. */
  }
};

export const beginReplyGateAttempt = (config: DSHBridgeConfig) => {
  const value = readReplyGateStatistics(config);

  value.total += 1;
  value.updatedAt = Date.now();
  persist(config, value);
  let settled = false;

  return (success: boolean) => {
    if (settled) return;
    settled = true;
    const current = readReplyGateStatistics(config);

    if (success) current.success += 1;
    else current.failed += 1;
    current.updatedAt = Date.now();
    persist(config, current);
  };
};
