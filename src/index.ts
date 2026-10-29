import { getAffinityStore } from './companion/affinity';
import { budgetEnabled, budgetRedis } from './billing/budget';
import { writeFile } from 'node:fs/promises';
import { defineChildren, logger, setCron } from 'alemonjs';
import response from '@src/router';
import { getDSHConfig, watchDSHConfig } from '@src/dsh/runtime-config';
import { runtimeSummary } from '@src/dsh/config';
import { ensureDSHSupervisor } from '@src/dsh/supervisor';
import { SessionRegistry } from '@src/state/registry';
import { purgeGroupHashData } from '@src/dsh/client';
import { getChatArchive } from './history/store';
import { getModuleRuntime, closeModuleRuntime } from './agent/modules';
import { getMemoryStore } from './memory/store';
import { getQAStore } from './qa/store';
import { getMoodStore } from './companion/mood';
import { getPlatformLedger } from './platform/ledger';
import { getProactiveStore } from './proactive/store';
import { interruptAllProactive } from './proactive/control';
import { autoStickerCollector } from './media/sticker-auto';
import { clearRecentMedia } from './media/recent';
import { ensureStickerRoot } from './media/stickers';
import { warmCredentialPool, stopCredentialPool } from './credentials/pool';
import { getMediaConfig } from './media/config';
import { startStickerPanel, type StickerPanel } from './panel/sticker-panel';
import { initializeAdminPanel, disposeAdminPanel } from './panel/admin-panel';
import apiRouter from './api-router';
let adminStart: Promise<void> = Promise.resolve();
let stopModuleConfigWatch: (() => void) | undefined;
let stickerPanel: StickerPanel | undefined;
let panelChain = Promise.resolve();
let panelStopped = false;

type PanelConfig = ReturnType<typeof getDSHConfig>;
const syncStickerPanel = (config: PanelConfig): Promise<void> => {
  panelChain = panelChain.then(async () => {
    if (panelStopped) return;
    await stickerPanel?.close().catch(() => undefined);
    stickerPanel = undefined;
    try {
      stickerPanel = await startStickerPanel(config);
    } catch (error) {
      logger.warn({ err: error }, 'Sticker panel failed to start');
    }
  });

  return panelChain;
};

export default defineChildren({
  register() {
    return {
      response,
      koaRouter: apiRouter
    };
  },
  onCreated() {
    panelStopped = false;
    adminStart = initializeAdminPanel().catch(() => logger.warn('管理接口初始化失败，请检查配置文件路径和权限'));
    try {
      const startupConfig = getDSHConfig();

      logger.info(runtimeSummary(startupConfig), 'AgentLink runtime resolved');
      warmCredentialPool(startupConfig);
      if (budgetEnabled(startupConfig)) {
        void budgetRedis()
          .then(() =>
            logger.info(
              {
                replyGateDailyYuan: startupConfig.budget?.replyGateDailyYuan ?? 1,
                personalDailyYuan: startupConfig.budget?.personalDailyYuan ?? startupConfig.budget?.privateDailyYuan ?? 1
              },
              'AgentLink Redis budget protection enabled'
            )
          )
          .catch(() => logger.error('AgentLink budget Redis unavailable; paid calls are blocked'));
      }

      void ensureStickerRoot(getMediaConfig()).catch(() => logger.warn('Default sticker library could not be prepared'));
      stopModuleConfigWatch?.();
      stopModuleConfigWatch = watchDSHConfig(() => {
        interruptAllProactive();
        autoStickerCollector.reset();
        clearRecentMedia();
        try {
          const next = getDSHConfig();

          logger.info(runtimeSummary(next), 'AgentLink runtime reloaded');
          warmCredentialPool(next);
          void syncStickerPanel(next);
          void getModuleRuntime(next)
            .then(runtime => runtime.refresh())
            .catch(() => logger.warn('AgentLink module configuration reload failed'));
        } catch {
          logger.warn('AgentLink module configuration is invalid');
        }
      });
      void syncStickerPanel(startupConfig);

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
        getQAStore(config).cleanup(config.retentionDays);
        getMoodStore(config).cleanup(config.retentionDays);
        getAffinityStore(config).cleanup(config.retentionDays);
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
    clearRecentMedia();
    stopModuleConfigWatch?.();
    stopModuleConfigWatch = undefined;
    stopCredentialPool();
    panelStopped = true;
    const closePanel = panelChain.then(async () => {
      await stickerPanel?.close().catch(() => undefined);
      stickerPanel = undefined;
    });

    return Promise.all([adminStart.then(() => disposeAdminPanel()), closePanel, closeModuleRuntime()]).then(() => undefined);
  }
});
