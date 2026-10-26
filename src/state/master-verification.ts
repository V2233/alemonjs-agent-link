import { randomInt } from 'node:crypto';

const lifetimeMs = 5 * 60 * 1000;

export class MasterVerification {
  private pending = new Map<string, { code: string; expiresAt: number; attempts: number }>();

  issue(identity: string, now = Date.now()): string {
    for (const [key, entry] of this.pending) {
      if (entry.expiresAt <= now) {
        this.pending.delete(key);
      }
    }
    const code = String(randomInt(100000, 1000000));

    this.pending.set(identity, { code, expiresAt: now + lifetimeMs, attempts: 0 });

    return code;
  }

  verify(identity: string, code: string, now = Date.now()): boolean {
    const entry = this.pending.get(identity);

    if (!entry || entry.expiresAt <= now) {
      this.pending.delete(identity);

      return false;
    }
    entry.attempts += 1;
    const valid = entry.code === code;

    if (valid || entry.attempts >= 5) {
      this.pending.delete(identity);
    }

    return valid;
  }
}

export const masterVerification = new MasterVerification();
