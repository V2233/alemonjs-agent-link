// Short follow-ups may borrow only this speaker's recent query in the same session generation.
export class MemoryQueryContext {
  private readonly entries = new Map<string, { text: string; at: number }>();
  resolve(scope: { platform: string; channelId: string; userId: string; generation?: number }, text: string, update = true, now = Date.now()): string {
    const key = JSON.stringify([scope.platform, scope.channelId, scope.userId, scope.generation]);
    const previous = this.entries.get(key);
    const short = text.trim().length < 8;
    const query = short && previous && now - previous.at < 300000 ? `${previous.text} ${text}` : text;

    if (update && !short) {
      this.entries.delete(key);
      this.entries.set(key, { text: text.slice(0, 500), at: now });
    }
    for (const [id, entry] of this.entries) {
      if (now - entry.at >= 300000) {
        this.entries.delete(id);
      }
    }
    while (this.entries.size > 1000) {
      this.entries.delete(this.entries.keys().next().value);
    }

    return query;
  }
}
