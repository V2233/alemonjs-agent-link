import type { GroupMessage } from './group-conversation';

// Controls must be an entire current message, not a phrase inside a quote or story.
export const speechControl = (text: string): 'hold' | 'release' | 'stop' | undefined => {
  const value = text
    .trim()
    .replace(/^(?:大肥鱼|小肥鱼|肥鱼|deepseek|dsh)[，,：:\s]*/iu, '')
    .replace(/[。！!，,~～]+$/u, '');

  if (/^(?:别回了|别回复了|不用回复|不用回答|不要回复|不要回答|停止回复|停止回答)$/u.test(value)) {
    return 'stop';
  }

  if (/^(?:等我说完|等我发完|等我发完再回|我还没说完|先别回|先别回复|先别回答|让我说完)$/u.test(value)) {
    return 'hold';
  }
  if (/^(?:说完了|发完了|可以回了|可以回复了|可以回答了|现在可以回复了)$/u.test(value)) {
    return 'release';
  }

  return undefined;
};

type Fragment = { messages: GroupMessage[]; expires: number; holding: boolean };
export class MessageFragments {
  private readonly users = new Map<string, Fragment>();
  private key(message: GroupMessage): string {
    return JSON.stringify([message.platform || '', message.userId]);
  }
  private prune(now: number): void {
    for (const [key, value] of this.users) {
      if (value.expires <= now) {
        this.users.delete(key);
      }
    }
  }
  holding(message: GroupMessage, now: number): boolean {
    this.prune(now);

    return Boolean(this.users.get(this.key(message))?.holding);
  }
  save(messages: GroupMessage[], now: number, holding = false): void {
    this.prune(now);
    for (const message of messages) {
      const key = this.key(message);
      const value = this.users.get(key) || { messages: [], expires: now + 45000, holding };

      value.holding ||= holding;
      if (!value.messages.some(item => item.id && item.id === message.id)) {
        value.messages.push(message);
      }
      while (value.messages.length > 20 || value.messages.reduce((sum, item) => sum + item.text.length + (item.referenceContext?.length || 0), 0) > 6000) {
        value.messages.shift();
      }
      value.expires = now + (value.holding ? 120000 : 45000);
      this.users.delete(key);
      this.users.set(key, value);
      while (this.users.size > 100) {
        this.users.delete(this.users.keys().next().value);
      }
    }
  }
  take(message: GroupMessage, now: number): GroupMessage[] {
    this.prune(now);
    const key = this.key(message);
    const value = this.users.get(key);

    this.users.delete(key);

    return value?.messages || [];
  }
  clear(userKey?: string): boolean {
    const before = this.users.size;

    if (userKey === undefined) {
      this.users.clear();

      return before > 0;
    }
    for (const [key, value] of this.users) {
      if (value.messages.some(message => message.userKey === userKey)) {
        this.users.delete(key);
      }
    }

    return this.users.size < before;
  }
}
