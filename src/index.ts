import { budgetEnabled, budgetRedis } from './billing/budget';
import { writeFile } from 'node:fs/promises';
import { defineChildren, logger, setCron } from 'alemonjs';
import response from '@src/router';
import { getDSHConfig, watchDSHConfig } from '@src/dsh/runtime-config';
import { ensureDSHSupervisor } from '@src/dsh/supervisor';
import { SessionRegistry } from '@src/state/registry';
import { purgeGroupHashData } from '@src/dsh/client';
import { getChatArchive } from './history/store';
import { getModuleRuntime, closeModuleRuntime } from './agent/modules';
import { getMemoryStore } from './memory/store';
import { getMoodStore } from './companion/mood';
import { getPlatformLedger } from './platform/ledger';
import { getProactiveStore } from './proactive/store';
import { interruptAllProactive } from './proactive/control';
import { autoStickerCollector } from './media/sticker-auto';
let stopModuleConfigWatch: (() => void) | undefined;

export default defineChildren({
  register() {
    return {
      response
    };
  },
  onCreated() {
    try {
      const startupConfig = getDSHConfig();

      if (budgetEnabled(startupConfig)) {
        void budgetRedis()
          .then(() =>
            logger.info(
              { groupDailyYuan: startupConfig.budget?.groupDailyYuan ?? 2, privateDailyYuan: startupConfig.budget?.privateDailyYuan ?? 1 },
              'AgentLink Redis budget protection enabled'
            )
          )
          .catch(() => logger.error('AgentLink budget Redis unavailable; paid calls are blocked'));
      }

      stopModuleConfigWatch?.();
      stopModuleConfigWatch = watchDSHConfig(() => {
        interruptAllProactive();
        autoStickerCollector.reset();
        try {
          void getModuleRuntime(getDSHConfig())
            .then(runtime => runtime.refresh())
            .catch(() => logger.warn('AgentLink module configuration reload failed'));
        } catch {
          logger.warn('AgentLink module configuration is invalid');
        }
      });

      void getModuleRuntime(startupConfig)
        .then(runtime => runtime.refresh())
        .catch(() => logger.error('AgentLink module startup failed'));

      void new SessionRegistry(startupConfig)
        .ready()
        .then(() => ensureDSHSupervisor(startupConfig))
        .then(supervisor => supervisor.start())
        .catch(async error => {
          logger.error({ err: error }, 'DSH bridge failed to start');
          if (process.env.AGENT_LINK_STATUS_PATH) {
            await writeFile(process.env.AGENT_LINK_STATUS_PATH, JSON.stringify({ phase: 'failed', chatReady: false, detail: '状态库或运行环境初始化失败。' }), {
              mode: 0o600
            }).catch(() => undefined);
          }
        });
    } catch (error) {
      logger.error({ err: error }, 'DSH bridge configuration invalid');
    }
    try {
      const cleanup = async (): Promise<void> => {
        const config = getDSHConfig();

        getChatArchive(config).cleanup();
        getMemoryStore(config).cleanup(config.retentionDays);
        getMoodStore(config).cleanup(config.retentionDays);
        getPlatformLedger(config).cleanup(config.retentionDays);
        getProactiveStore(config).cleanup(config.retentionDays);
        const registry = new SessionRegistry(config);

        let groups = await registry.expiredGroups();

        while (groups.length > 0) {
          for (const group of groups) {
            await purgeGroupHashData(config, group);
            await registry.purgeHash(group, false);
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
  },
  onDispose() {
    interruptAllProactive();
    autoStickerCollector.reset();
    stopModuleConfigWatch?.();
    stopModuleConfigWatch = undefined;

    return closeModuleRuntime();
  }
});
