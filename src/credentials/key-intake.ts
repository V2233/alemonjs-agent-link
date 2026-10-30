import { randomBytes } from 'node:crypto';

export const extractApiKeys = (text: string): string[] => [
  ...new Set(
    [...text.matchAll(/(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{8,240}(?![A-Za-z0-9_-])/gu)]
      .map(match => match[0])
      .filter(key => !/^sk-(?:your[-_]?key|your[-_]?api[-_]?key|placeholder)$/iu.test(key))
  )
];

type Pending = { actor: string; key: string; expires: number; busy: boolean };
export class KeyIntake {
  private pending = new Map<string, Pending>();
  constructor(private readonly now = Date.now) {}
  offer(actor: string, key: string): string {
    for (const [id, item] of this.pending) {
      if (!item.busy && (item.expires <= this.now() || item.actor === actor)) this.pending.delete(id);
    }
    if (this.pending.size >= 1000) throw new Error('添加请求较多，请稍后重试。');
    const id = randomBytes(16).toString('hex');

    this.pending.set(id, { actor, key, expires: this.now() + 5 * 60_000, busy: false });

    return id;
  }
  async confirm(actor: string, id: string, save: (key: string) => Promise<void>): Promise<void> {
    const item = this.pending.get(id);

    if (item?.actor !== actor || item.expires <= this.now()) {
      if (item?.expires <= this.now() && !item.busy) this.pending.delete(id);
      throw new Error('这次添加已失效，请重新私聊发送 Key。');
    }
    if (item.busy) throw new Error('正在添加，请勿重复点击。');
    item.busy = true;
    try {
      await save(item.key);
      this.pending.delete(id);
    } catch (error) {
      item.busy = false;
      throw error;
    }
  }
}
export const keyIntake = new KeyIntake();
