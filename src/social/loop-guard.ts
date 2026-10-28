// Short-lived group-local circuit breaker, not a claim about a person's identity.
const normalize = (text: string): string =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '')
    .slice(0, 2000);

export class LoopGuard {
  private peers = new Map<string, { replies: number[]; inputs: string[]; blockedUntil: number; blockedFor?: 'rate' | 'loop'; lastSeen: number }>();
  private outputs: { at: number; text: string }[] = [];

  allows(user: string, text: string, now: number, isBot = false, explicit = false): boolean {
    if (isBot) {
      return false;
    }
    const peer = this.peers.get(user);

    if (peer && peer.blockedUntil > now && !(explicit && peer.blockedFor === 'rate')) {
      return false;
    }
    const key = normalize(text);
    const repeated = key.length >= 8 && peer?.lastSeen > now - 120000 && peer.inputs.includes(key);
    const echo = key.length >= 12 && this.outputs.some(item => now - item.at < 120000 && item.text === key);
    const excessive = !explicit && peer && peer.replies.filter(at => now - at < 120000).length >= 4;

    if (repeated || echo || excessive) {
      if (peer) {
        peer.blockedUntil = now + 120000;
        peer.blockedFor = repeated || echo ? 'loop' : 'rate';
      }

      return false;
    }

    return true;
  }

  delivered(user: string, input: string, output: string, now: number): void {
    for (const [id, peer] of this.peers) {
      if (now - peer.lastSeen > 240000) {
        this.peers.delete(id);
      }
    }
    if (!this.peers.has(user) && this.peers.size >= 1000) {
      this.peers.delete(this.peers.keys().next().value);
    }
    const previous = this.peers.get(user);

    this.peers.set(user, {
      replies: [...(previous?.replies || []).filter(at => now - at < 120000), now],
      inputs: [...(previous && now - previous.lastSeen < 120000 ? previous.inputs : []), normalize(input)].slice(-4),
      blockedUntil: previous?.blockedUntil || 0,
      blockedFor: previous?.blockedFor,
      lastSeen: now
    });
    if (output) {
      this.outputs = [...this.outputs.filter(item => now - item.at < 120000), { at: now, text: normalize(output) }].slice(-16);
    }
  }
}
