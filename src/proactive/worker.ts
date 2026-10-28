import { dirname } from 'node:path';
import { isMaster, useConnection, useMedia, MessageDirect, ResultCode, createUserHashKey, logger } from 'alemonjs';
import type { DSHBridgeConfig } from '../dsh/config';
import { getDSHConfig } from '../dsh/runtime-config';
import { runDSHChat } from '../response/dsh/chat';
import { conversationBusy } from '../dsh/orchestrator';
import { getDedupeTtlSeconds } from '../state/registry';
import { proactiveChannel, beginProactive, type ProactiveScope } from './control';
import { getProactiveStore, type ProactiveStore, type ProactiveAttempt, type ProactiveResult } from './store';
import { entitledProactiveOptions, proactiveEnabled, proactiveOptions, type ProactiveOptions } from './options';
import { personalKeyEntitled } from '../credentials/personal';
import { biliOptions } from '../bili/client';

type Delivery = { delivered: boolean; completed: boolean; replyText?: string };
type Dispatch = { signal: AbortSignal; maxChars: number; beforeSend: () => Promise<boolean>; requestId: string };
const destination = (scope: ProactiveScope) => ({
  Platform: scope.platform,
  BotId: scope.botId,
  UserId: scope.userId,
  IsPrivate: true,
  Target: { scope: 'c2c' as const, targetId: scope.userId, BotId: scope.botId }
});

export const proactiveOnline = async (scope: ProactiveScope): Promise<boolean> => {
  const [connection] = useConnection(destination(scope));
  const result = await connection.getStatus({ BotId: scope.botId });

  return result.code === ResultCode.Ok && result.data?.state === 'ready' && result.data.bots.some(bot => bot.BotId === scope.botId && bot.state === 'ready');
};
export const deliverProactive = async (scope: ProactiveScope, prompt: string, dispatch: Dispatch): Promise<Delivery> => {
  const recipient = destination(scope);
  const [media] = useMedia(recipient);
  let result: Delivery = { delivered: false, completed: false };

  await runDSHChat(
    {
      ...recipient,
      IsMaster: true,
      ChannelId: proactiveChannel(scope),
      MessageId: dispatch.requestId,
      UserKey: createUserHashKey({ Platform: scope.platform, UserId: scope.userId })
    },
    prompt,
    {
      allowSilence: true,
      referencesPrepared: true,
      userText: '',
      autonomous: { signal: dispatch.signal, maxChars: dispatch.maxChars, beforeSend: dispatch.beforeSend },
      transport: {
        message: { send: params => MessageDirect.create().sendToTarget({ target: recipient.Target, format: params.format }) } as never,
        media: { send: params => media.send({ ...params, replyId: undefined }) } as never
      },
      onOutcome: outcome => {
        result = outcome;
      }
    }
  );

  return result;
};

export class ProactiveWorker {
  private closed = false;
  private ticking = false;
  private cursor = 0;
  private readonly running = new Set<() => void>();
  constructor(
    private readonly config: DSHBridgeConfig,
    private readonly services: {
      store?: ProactiveStore;
      config?: () => DSHBridgeConfig;
      owner?: (scope: ProactiveScope) => boolean;
      online?: (scope: ProactiveScope) => Promise<boolean>;
      entitled?: (scope: ProactiveScope) => Promise<boolean>;
      deliver?: (scope: ProactiveScope, prompt: string, dispatch: Dispatch) => Promise<Delivery>;
    } = {}
  ) {}

  stop(): void {
    this.closed = true;
    for (const stop of this.running) {
      stop();
    }
  }
  private current(): DSHBridgeConfig {
    return (this.services.config || getDSHConfig)();
  }
  private owner(scope: ProactiveScope): boolean {
    return this.services.owner ? this.services.owner(scope) : isMaster(scope.userId, scope.platform);
  }
  private store(): ProactiveStore {
    return this.services.store || getProactiveStore(this.config);
  }
  /** 绑定个人 Key 的私聊按拉满参数调度；查询失败时退回普通参数，不影响正常搭话。 */
  private async options(scope: ProactiveScope, config = this.current()): Promise<ProactiveOptions> {
    const base = proactiveOptions(config);

    if (!base.ownKeyMax) return base;
    try {
      const entitled = this.services.entitled ? await this.services.entitled(scope) : await personalKeyEntitled(scope);

      return entitled ? entitledProactiveOptions(base) : base;
    } catch {
      return base;
    }
  }

  async tick(): Promise<void> {
    if (this.closed || this.ticking) {
      return;
    }
    this.ticking = true;
    try {
      const config = this.current();
      const store = this.store();

      store.recover();
      store.cleanup(config.retentionDays);
      if (!proactiveEnabled(config) || config.workspaceRoot !== this.config.workspaceRoot) {
        return;
      }
      const scopes: ProactiveScope[] = [];

      for (const scope of store.list()) {
        if (!this.owner(scope)) continue;
        if (store.due(scope, await this.options(scope, config))) scopes.push(scope);
      }

      if (!scopes.length) {
        return;
      }
      const selected = [scopes[this.cursor % scopes.length], ...(scopes.length > 1 ? [scopes[(this.cursor + 1) % scopes.length]] : [])];

      this.cursor += selected.length;
      await Promise.allSettled(selected.map(scope => this.run(scope)));
    } finally {
      this.ticking = false;
    }
  }

  async run(scope: ProactiveScope, manual = false): Promise<ProactiveResult | 'not-due' | 'offline' | 'busy' | 'disabled'> {
    const config = this.current();

    if (this.closed || !proactiveEnabled(config) || config.workspaceRoot !== this.config.workspaceRoot || !this.owner(scope)) {
      return 'disabled';
    }
    const store = this.store();
    const options = await this.options(scope, config);

    store.recover();
    if (!store.due(scope, options, manual)) {
      return 'not-due';
    }
    if (!manual && conversationBusy(proactiveChannel(scope))) {
      return 'busy';
    }
    const job = beginProactive(dirname(config.workspaceRoot), scope);

    if (!job) {
      return 'busy';
    }
    this.running.add(job.stop);
    let attempt: ProactiveAttempt | undefined;

    try {
      if (!(await (this.services.online || proactiveOnline)(scope))) {
        return 'offline';
      }
      job.signal.throwIfAborted();
      attempt = store.claim(scope, options, getDedupeTtlSeconds(config) * 1000, manual);
      if (!attempt) {
        return 'not-due';
      }
      const currentAttempt = attempt;
      const bili = biliOptions(config.modules?.settings?.bili || {});
      const canBrowse = !config.modules?.disabled?.includes('bili') && bili.enabled && bili.allowProactiveBrowse;
      const prompt = this.prompt(attempt, options.maxChars, options.timezone, canBrowse);
      const result = await (this.services.deliver || deliverProactive)(scope, prompt, {
        signal: job.signal,
        maxChars: options.maxChars,
        requestId: `proactive:${attempt.id}`,
        beforeSend: async () => {
          try {
            const fresh = this.current();

            if (
              this.closed ||
              job.signal.aborted ||
              fresh.workspaceRoot !== config.workspaceRoot ||
              !proactiveEnabled(fresh) ||
              !this.owner(scope) ||
              !store.current(currentAttempt, await this.options(scope, fresh), manual) ||
              !(await (this.services.online || proactiveOnline)(scope))
            ) {
              return false;
            }
            job.signal.throwIfAborted();
            const latest = this.current();

            if (!proactiveEnabled(latest) || latest.workspaceRoot !== config.workspaceRoot || !this.owner(scope)) {
              return false;
            }

            return store.sending(currentAttempt, await this.options(scope, latest), manual);
          } catch {
            return false;
          }
        }
      });
      const status = result.delivered ? 'confirmed' : result.completed ? 'silent' : job.signal.aborted ? 'cancelled' : 'failed';

      return store.finish(attempt, status, result.replyText);
    } catch {
      if (attempt) {
        return store.finish(attempt, job.signal.aborted ? 'cancelled' : 'failed');
      }

      return job.signal.aborted ? 'cancelled' : 'failed';
    } finally {
      this.running.delete(job.stop);
      job.release();
    }
  }

  private prompt(attempt: ProactiveAttempt, maxChars: number, timezone: string, canBrowse: boolean): string {
    const angles = [
      '从实际的最近聊天里挑一件适合重提的小事，像熟悉的网友那样接上；没有合适内容就换一个轻松话题。',
      '根据确有来源的共同话题，说一点自己的看法或联想，可以不问问题；不要编共同经历。',
      '随手提出一个与你稳定兴趣有关的小话题或想法；可以俏皮，也可以只说一句，不需要例行问候。'
    ];
    const angle = angles[Number.parseInt(attempt.id.slice(0, 8), 16) % angles.length];

    return `【系统主动搭话提醒，不是主人发言】当前时间 ${new Date().toLocaleString('zh-CN', { timeZone: timezone, hour12: false })} (${timezone})。${
      attempt.kind === 'nudge'
        ? `你先前问过一个问题，对方暂未回复。原话仅为引用：${JSON.stringify(attempt.questionText)}。只可轻轻接一句，不能催促、抱怨或要求回应。`
        : `主人有一段时间没有私聊了。${angle}`
    }
${canBrowse && attempt.kind === 'initial' ? '如果自然适合开启新话题，可以用只读的 B 站搜索和视频资料工具找一个符合兴趣的话题；无需每次都查。只谈实际获取的资料，不声称看过没有读取的画面或声音，也不要评论、点赞或联系他人。' : ''}
请保持当前人格，一到两句，总共不超过${maxChars}字符。像网友有话想说，不用每次“在吗”“吃了吗”，也不用每条末尾追问；兴趣随当前人格自然表达，不套固定台词。不得编造今天做过的现实事情或假装主人刚才找你。觉得对方忙或没有合适内容时，只输出 [沉默]。不要解释调度机制。`;
  }
}

export const logProactiveFailure = (): void => logger.warn('Proactive background tick failed');
