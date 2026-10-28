import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type BridgeUsage = { requests: number; input: number; output: number };
export type BridgeMetrics = {
  date: string;
  endpoints: Record<string, BridgeUsage>;
  personal: BridgeUsage;
};

const usage = (value: unknown): BridgeUsage => {
  const item = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

  return {
    requests: Math.max(0, Number(item.requests) || 0),
    input: Math.max(0, Number(item.input) || 0),
    output: Math.max(0, Number(item.output) || 0)
  };
};

export const readBridgeMetrics = async (config: { dshHomeRoot: string }): Promise<BridgeMetrics | null> => {
  try {
    const raw = JSON.parse(await readFile(join(dirname(config.dshHomeRoot), 'model-pool-bridge-metrics.json'), 'utf8')) as Record<string, unknown>;
    const endpoints: Record<string, BridgeUsage> = {};

    if (raw.endpoints && typeof raw.endpoints === 'object') {
      for (const [id, value] of Object.entries(raw.endpoints as Record<string, unknown>)) endpoints[id] = usage(value);
    }

    return { date: typeof raw.date === 'string' ? raw.date : '', endpoints, personal: usage(raw.personal) };
  } catch {
    return null;
  }
};
