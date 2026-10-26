import type { AgentModule } from '../agent/types';
import type { DSHBridgeConfig } from '../dsh/config';
import { proactiveOptions } from '../proactive/options';
import { ProactiveWorker, logProactiveFailure } from '../proactive/worker';

export const proactiveModule = (config: DSHBridgeConfig): AgentModule => ({
  id: 'proactive',
  name: '主动搭话',
  version: '1.0.0',
  apiVersion: 1,
  setup(api) {
    proactiveOptions(config);
    const worker = new ProactiveWorker(config);
    const timer = setInterval(() => {
      void worker.tick().catch(logProactiveFailure);
    }, 60000);

    timer.unref();
    api.onDispose(() => {
      clearInterval(timer);
      worker.stop();
    });
  }
});
