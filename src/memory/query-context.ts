// Short follow-ups may borrow only this speaker's recent query in the same session generation.
export class MemoryQueryContext {
  private readonly entries = new Map<string, { text: string; at: number }>();
  resolve(scope: { platform: string; channelId: string; userId: string; generation?: number }, text: string, update = true, now = Date.now()): string {
    const key = JSON.stringify([scope.platform, scope.channelId, scope.userId, scope.generation]);
    const previous = this.entries.get(key);
    const short =
      /^(嗯+|哦+|好[的吧]?|行|对[的呀]?|是的|然后呢?|还有呢?|继续|那[个些]呢?|我那个呢|为什么|怎么说|展开说说|ok|yes|and then)[。！!？?\s]*$/iu.test(
        text.trim()
      );
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
