import { cbpPlatform, definePlatform, getAppConfigValue, getConfigValue, isMaster, logger } from 'alemonjs';
import { OneBotConnection } from './connection';
import { resolveOneBotConfig } from './config';
import { normalizeOneBotEvent } from './events';
import { OneBotActions } from './actions';

export const startOneBot = () => {
  const options = resolveOneBotConfig(getConfigValue());
  const bridge = cbpPlatform();
  const connection = new OneBotConnection(options, {
    event: raw => {
      try {
        const event = normalizeOneBotEvent(raw, options.selfId, id => isMaster(id, 'onebot'));

        if (event) {
          bridge.send(event);
        }
      } catch {
        logger.warn('OneBot inbound event rejected');
      }
    },
    ready: () => bridge.send({ name: 'connection.ready', Platform: 'onebot', BotId: options.selfId, value: '', transport: 'onebot-v11' })
  });
  const actions = new OneBotActions(connection, () => {
    const { modules } = getAppConfigValue<import('../dsh/config').AgentConfig>();

    return {
      owner: id => isMaster(id, 'onebot'),
      groups: Array.isArray(modules?.settings?.['group-admin']?.groups) ? modules.settings['group-admin'].groups : [],
      disabled: modules?.disabled || []
    };
  });

  bridge.onactions((frame, consume) => {
    void actions.action(frame).then(consume);
  });
  bridge.onapis((frame, consume) => {
    void actions.api(frame).then(consume);
  });
  connection.start();

  return { stop: () => connection.stop() };
};

export default definePlatform({ name: 'onebot', main: startOneBot });
