import type { AgentModule } from '../agent/types';
import type { DSHBridgeConfig } from '../dsh/client';
import { getPersonaStore } from '../companion/personas';

export const personaModule = (config: DSHBridgeConfig): AgentModule => ({
  id: 'persona',
  name: '人格',
  version: '1.0.0',
  apiVersion: 1,
  setup(api) {
    const store = getPersonaStore(config);

    api.on('system', (base, context) => (context.platform && context.channelId ? store.systemPrompt({ ...config, defaultSystemPrompt: base }, context) : base));
  }
});
