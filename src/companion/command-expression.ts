import type { DSHBridgeConfig } from '../dsh/client';
import { getPersonaStore, type PersonaScope } from './personas';

/** Fixed commands keep their authoritative facts; only their phrasing varies. */
export const commandExpression = (config: DSHBridgeConfig, scope: PersonaScope, natural: string, concise: string): string => {
  if (config.modules?.disabled?.includes('persona')) return concise;
  const store = getPersonaStore(config);
  const persona = store.selected(scope) || config.modules?.settings?.persona?.defaultId || config.persona;
  const mode = store.expressionMode(scope);

  return persona === 'dafeiyu' && (mode === '活跃' || mode === '个性') ? natural : concise;
};

export const commandMoodText = (value: number): string =>
  value >= 75 ? '现在心情不错，挺想聊两句的。' : value >= 45 ? '现在心情挺平和的。' : value >= 25 ? '现在有点低落，想慢慢聊。' : '现在有些疲惫，想安静一点。';
