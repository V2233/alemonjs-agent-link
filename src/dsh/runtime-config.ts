import { isDeepStrictEqual } from 'node:util';
import { getAppConfig, getConfigValue, onWatchConfigValue } from 'alemonjs';
import { resolveDSHConfig, type DSHBridgeConfig, type AgentConfig, type ConfigContext } from './config';

type FrameworkConfig = { db?: { redis?: unknown } };

// Explicit snapshots remain supported for pure parsing and tests.
export const getDSHConfig = (value?: AgentConfig, context: ConfigContext = {}): DSHBridgeConfig => {
  if (value !== undefined) {
    return resolveDSHConfig(value, context);
  }
  const app = getAppConfig<AgentConfig>();

  return resolveDSHConfig(app.value, {
    configPath: app.path ?? undefined,
    hasRedis: Boolean(getConfigValue<FrameworkConfig>().db?.redis),
    ...context
  });
};

export const watchDSHConfig = (listener: () => void): (() => void) => {
  const app = getAppConfig<AgentConfig>();
  const snapshot = () => ({
    value: app.value,
    // Global Redis only affects the implicit backend selection.
    redis: app.value.stateBackend === undefined && Boolean(getConfigValue<FrameworkConfig>().db?.redis)
  });
  let previous = structuredClone(snapshot());
  const notify = () => {
    const current = snapshot();

    if (isDeepStrictEqual(previous, current)) {
      return;
    }
    previous = structuredClone(current);
    listener();
  };

  app.onWatch(notify);
  const stopRedisWatch = onWatchConfigValue(notify);

  return () => {
    app.dispose();
    stopRedisWatch();
  };
};
