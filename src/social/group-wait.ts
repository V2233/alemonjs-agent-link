export type GroupWaitRequest = { action: 'wait' | 'cancel' | 'status'; seconds?: number; speakerId?: string; keyword?: string };
type Plan = { speakerId: string; keyword: string; expiresAt: number };
type Ticket = { platform: string; userKey: string; plan?: Plan };
export type GroupWaitResult = { ok: boolean; state?: 'waiting' | 'idle'; speakerId?: string; keyword?: string; expiresAt?: number; message?: string };
const normalized = (text: string): string => text.normalize('NFKC').toLocaleLowerCase('en-US');

/** Event-driven waiting: no model request or platform send is scheduled by a timeout. */
export class GroupWaitController {
  private readonly slots = new Map<string, Ticket>();
  begin(platform: string, userKey: string): Ticket {
    const ticket = { platform, userKey };

    this.slots.set(platform, ticket);

    return ticket;
  }
  apply(ticket: Ticket, request: GroupWaitRequest, knownSpeakers: string[], currentSpeaker: string, now: number): GroupWaitResult {
    if (this.slots.get(ticket.platform) !== ticket) return { ok: false, message: '本轮等待设置已失效。' };
    if (ticket.plan?.expiresAt <= now) ticket.plan = undefined;
    if (request.action === 'cancel') ticket.plan = undefined;
    else if (request.action === 'wait') {
      const seconds = request.seconds ?? 120;
      const speakerId = request.speakerId ?? currentSpeaker;
      const keyword = (request.keyword ?? '').trim();

      if (!Number.isInteger(seconds) || seconds < 15 || seconds > 300 || !knownSpeakers.includes(speakerId) || keyword.length > 40 || /[\r\n\0]/u.test(keyword))
        return { ok: false, message: '只能等待本批已知发言人，期限为15–300秒，关键词最多40字且为单行。' };
      ticket.plan = { speakerId, keyword, expiresAt: now + seconds * 1000 };
    } else if (request.action !== 'status') return { ok: false, message: '等待动作无效。' };

    return ticket.plan ? { ok: true, state: 'waiting', ...ticket.plan } : { ok: true, state: 'idle' };
  }
  observe(message: { platform?: string; userId: string; text: string; direct: boolean }, now: number): 'idle' | 'waiting' | 'matched' {
    const platform = message.platform || '';
    const plan = this.slots.get(platform)?.plan;

    if (!plan) return 'idle';
    if (plan.expiresAt <= now || message.direct) {
      this.slots.delete(platform);

      return 'idle';
    }
    if (message.userId === plan.speakerId && (!plan.keyword || normalized(message.text).includes(normalized(plan.keyword)))) {
      this.slots.delete(platform);

      return 'matched';
    }

    return 'waiting';
  }
  clear(userKey?: string): boolean {
    let changed = false;

    for (const [platform, ticket] of this.slots) {
      if (userKey === undefined || ticket.userKey === userKey) {
        this.slots.delete(platform);
        changed = true;
      }
    }

    return changed;
  }
}
