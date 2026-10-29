type Speaker = { platform?: string; userId: string; userKey: string; text: string };
export type ConversationExchange = { userText: string; replyText: string; at: number };
type Ticket = { userKey: string; expires: number; exchange?: ConversationExchange };

/** Short-lived, per-speaker invitations. A cleared ticket cannot be restored by a late reply. */
export class ConversationThreads {
  private readonly threads = new Map<string, Ticket>();
  private key(speaker: Speaker): string {
    return JSON.stringify([speaker.platform || '', speaker.userId]);
  }
  private prune(now: number): void {
    for (const [key, value] of this.threads) {
      if (value.expires <= now) this.threads.delete(key);
    }
  }
  exchange(speaker: Speaker, now: number): ConversationExchange | undefined {
    this.prune(now);

    return this.threads.get(this.key(speaker))?.exchange;
  }
  begin(speaker: Speaker, now: number): Ticket {
    this.prune(now);
    const key = this.key(speaker);
    const ticket: Ticket = { userKey: speaker.userKey, expires: now + 120000, exchange: this.threads.get(key)?.exchange };

    this.threads.delete(key);
    this.threads.set(key, ticket);
    while (this.threads.size > 100) this.threads.delete(this.threads.keys().next().value);

    return ticket;
  }
  delivered(speaker: Speaker, replyText: string, now: number, ticket: Ticket): void {
    if (!replyText.trim() || this.threads.get(this.key(speaker)) !== ticket) return;
    ticket.exchange = { userText: speaker.text.slice(0, 1000), replyText: replyText.slice(0, 2000), at: now };
    ticket.expires = now + 120000;
  }
  end(speaker: Speaker): boolean {
    return this.threads.delete(this.key(speaker));
  }
  clear(userKey?: string): boolean {
    let changed = false;

    for (const [key, value] of this.threads) {
      if (userKey === undefined || value.userKey === userKey) {
        this.threads.delete(key);
        changed = true;
      }
    }

    return changed;
  }
}
