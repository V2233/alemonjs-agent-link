export type GroupWaitRequest = { action: 'wait' | 'cancel' | 'status'; seconds?: number; speakerId?: string; speakerIds?: string[]; keyword?: string };
type Plan = { speakerId?: string; speakerIds: string[]; keyword: string; expiresAt: number };
export type GroupWaitSnapshot = Pick<Plan, 'speakerIds' | 'keyword' | 'expiresAt'>;
type Ticket = { platform: string; userKey: string; plan?: Plan };
export type PersistedGroupWait = { platform: string; userKey: string; createdAt: number; plan: GroupWaitSnapshot };
export type GroupWaitPersistence = { load: (now: number) => PersistedGroupWait | undefined; save: (value?: PersistedGroupWait) => void; failed?: () => void };
export type GroupWaitResult = {
  ok: boolean;
  state?: 'waiting' | 'idle';
  speakerId?: string;
  speakerIds?: string[];
  keyword?: string;
  expiresAt?: number;
  message?: string;
};
const normalized = (text: string): string => text.normalize('NFKC').toLocaleLowerCase('en-US');

/** Event-driven waiting: no model request or platform send is scheduled by a timeout. */
export class GroupWaitController {
  private readonly slots = new Map<string, Ticket>();
  private readonly createdAt = new Map<string, number>();
  constructor(
    private readonly persistence?: GroupWaitPersistence,
    now = Date.now()
  ) {
    try {
      const saved = persistence?.load(now);

      if (saved) {
        this.slots.set(saved.platform, {
          platform: saved.platform,
          userKey: saved.userKey,
          plan: {
            ...saved.plan,
            speakerIds: saved.plan.speakerIds.slice(),
            ...(saved.plan.speakerIds.length === 1 ? { speakerId: saved.plan.speakerIds[0] } : {})
          }
        });
        this.createdAt.set(saved.platform, saved.createdAt);
      }
    } catch {
      persistence?.failed?.();
    }
  }
  private remove(platform: string): boolean {
    this.slots.delete(platform);
    this.createdAt.delete(platform);
    try {
      this.persistence?.save();

      return true;
    } catch {
      this.persistence?.failed?.();

      return false;
    }
  }
  snapshot(platform: string, now: number): GroupWaitSnapshot | undefined {
    const plan = this.slots.get(platform)?.plan;

    if (!plan) return undefined;
    if (plan.expiresAt <= now || now < (this.createdAt.get(platform) ?? now)) {
      this.remove(platform);

      return undefined;
    }

    return { speakerIds: plan.speakerIds.slice(), keyword: plan.keyword, expiresAt: plan.expiresAt };
  }
  begin(platform: string, userKey: string): Ticket {
    const ticket = { platform, userKey };

    this.remove(platform);
    this.slots.set(platform, ticket);

    return ticket;
  }
  apply(ticket: Ticket, request: GroupWaitRequest, knownSpeakers: string[], currentSpeaker: string, now: number): GroupWaitResult {
    if (this.slots.get(ticket.platform) !== ticket) return { ok: false, message: '本轮等待设置已失效。' };
    if (ticket.plan?.expiresAt <= now || now < (this.createdAt.get(ticket.platform) ?? now)) {
      ticket.plan = undefined;
      this.createdAt.delete(ticket.platform);
      try {
        this.persistence?.save();
      } catch {
        this.persistence?.failed?.();
      }
    }
    if (request.action === 'cancel') {
      ticket.plan = undefined;
      this.createdAt.delete(ticket.platform);
      try {
        this.persistence?.save();
      } catch {
        this.persistence?.failed?.();

        return { ok: false, state: 'idle', message: '本进程已取消等待，但持久状态清理失败。' };
      }
    } else if (request.action === 'wait') {
      const seconds = request.seconds ?? 120;
      const candidates = request.speakerIds ?? [request.speakerId ?? currentSpeaker];

      if (
        (request.speakerId !== undefined && request.speakerIds !== undefined) ||
        !Array.isArray(candidates) ||
        candidates.length < 1 ||
        candidates.length > 5 ||
        candidates.some(id => typeof id !== 'string' || !id || id.length > 200 || !knownSpeakers.includes(id))
      )
        return { ok: false, message: '等待名单须为1–5名当前回合已读取的发言人，speakerId与speakerIds不能同时提供。' };
      const speakerIds = [...new Set(candidates)];
      const keyword = (request.keyword ?? '').trim();

      if (!Number.isInteger(seconds) || seconds < 15 || seconds > 300 || keyword.length > 40 || /[\r\n\0]/u.test(keyword))
        return { ok: false, message: '只能等待当前回合已读取的发言人，期限为15–300秒，关键词最多40字且为单行。' };
      const plan = { speakerId: speakerIds.length === 1 ? speakerIds[0] : undefined, speakerIds, keyword, expiresAt: now + seconds * 1000 };

      try {
        this.persistence?.save({ platform: ticket.platform, userKey: ticket.userKey, createdAt: now, plan });
      } catch {
        this.persistence?.failed?.();

        return { ok: false, message: '等待状态保存失败，本次设置未生效。' };
      }
      ticket.plan = plan;
      this.createdAt.set(ticket.platform, now);
    } else if (request.action !== 'status') return { ok: false, message: '等待动作无效。' };

    return ticket.plan ? { ok: true, state: 'waiting', ...ticket.plan, speakerIds: ticket.plan.speakerIds.slice() } : { ok: true, state: 'idle' };
  }
  observe(message: { platform?: string; userId: string; text: string; direct: boolean }, now: number): 'idle' | 'waiting' | 'matched' {
    const platform = message.platform || '';
    const plan = this.slots.get(platform)?.plan;

    if (!plan) return 'idle';
    if (plan.expiresAt <= now || now < (this.createdAt.get(platform) ?? now) || message.direct) {
      this.remove(platform);

      return 'idle';
    }
    if (plan.speakerIds.includes(message.userId) && (!plan.keyword || normalized(message.text).includes(normalized(plan.keyword)))) {
      return this.remove(platform) ? 'matched' : 'idle';
    }

    return 'waiting';
  }
  clear(userKey?: string): boolean {
    let changed = false;

    for (const [platform, ticket] of this.slots) {
      if (userKey === undefined || ticket.userKey === userKey) {
        this.remove(platform);
        changed = true;
      }
    }

    return changed;
  }
}
