import { defineChildren, logger, setCron } from 'alemonjs';
import response from '@src/router';
import { getDSHConfig } from '@src/dsh/client';
import { ensureDSHSupervisor } from '@src/dsh/supervisor';
import { SessionRegistry } from '@src/state/registry';
import { purgeGroupHashData } from '@src/dsh/client';
export default defineChildren({
  register() {
    return {
      response
    };
  },
  onCreated() {
    try {
      void ensureDSHSupervisor(getDSHConfig())
        .then(supervisor => supervisor.start())
        .catch(error => {
          logger.error({ err: error }, 'DSH bridge failed to start');
        });
    } catch (error) {
      logger.error({ err: error }, 'DSH bridge configuration invalid');
    }
    try {
      const config = getDSHConfig();
      const cleanup = async (): Promise<void> => {
        const registry = new SessionRegistry(config);

        let groups = await registry.expiredGroups();

        while (groups.length > 0) {
          for (const group of groups) {
            await purgeGroupHashData(config, group);
            await registry.purgeHash(group);
          }
          if (groups.length < 100) {
            break;
          }
          groups = await registry.expiredGroups();
        }
      };

      void cleanup().catch(error => logger.warn({ err: error }, 'AgentLink retention cleanup failed'));
      setCron('0 * * * *', () => {
        void cleanup().catch(error => logger.warn({ err: error }, 'AgentLink retention cleanup failed'));
      });
    } catch {
      /* configuration errors are already reported above */
    }
  }
});
