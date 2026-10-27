import { setTimeout as delay } from 'node:timers/promises';
import { DSHError } from './errors';

type Release = () => void;
type Waiter = { limit: number; signal: AbortSignal; resolve: (release: Release) => void; reject: (error: unknown) => void; abort: () => void };

// Continuations keep their conversation lock but release global execution capacity.
export class RequestSlotPool {
  private count = 0;
  private waiting: Waiter[] = [];
  get active(): number {
    return this.count;
  }

  private grant(): Release {
    this.count++;
    let released = false;

    return () => {
      if (released) return;
      released = true;
      this.count--;
      this.drain();
    };
  }

  acquire(limit: number): Release {
    if (this.count >= limit || this.waiting.length) throw new DSHError('http', 'Agent 服务繁忙，请稍后重试');

    return this.grant();
  }

  private drain(): void {
    while (this.waiting.length) {
      const next = this.waiting[0];

      if (this.count >= next.limit) return;
      this.waiting.shift();
      next.signal.removeEventListener('abort', next.abort);
      if (next.signal.aborted) next.reject(next.signal.reason);
      else next.resolve(this.grant());
    }
  }

  async requeue(release: Release, limit: number, signal: AbortSignal): Promise<Release> {
    release();
    // Yield one event-loop turn so already-ready work can claim the released slot.
    await delay(0, undefined, { signal });
    signal.throwIfAborted();

    return await new Promise<Release>((resolve, reject) => {
      const waiter: Waiter = {
        limit,
        signal,
        resolve,
        reject,
        abort: () => {
          this.waiting = this.waiting.filter(item => item !== waiter);
          reject(signal.reason);
          this.drain();
        }
      };

      this.waiting.push(waiter);
      signal.addEventListener('abort', waiter.abort, { once: true });
      if (signal.aborted) waiter.abort();
      else this.drain();
    });
  }
}
