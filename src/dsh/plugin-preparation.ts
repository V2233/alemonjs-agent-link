/** Nonblocking preparation for a verified plugin, with one task per runtime configuration. */
export class PluginPreparation {
  private current?: {
    key: string;
    controller: AbortController;
    phase: 'preparing' | 'ready' | 'failed';
    retryAfter: number;
    done: Promise<void>;
  };

  status(): 'idle' | 'preparing' | 'ready' | 'failed' {
    return this.current?.phase || 'idle';
  }

  start(key: string, prepare: (signal: AbortSignal) => Promise<unknown>, timeoutMs = 240000): void {
    const previous = this.current;

    if (previous?.key === key && (previous.phase !== 'failed' || Date.now() < previous.retryAfter)) return;
    previous?.controller.abort();
    const controller = new AbortController();
    const record = { key, controller, phase: 'preparing' as 'preparing' | 'ready' | 'failed', retryAfter: 0, done: Promise.resolve() };

    this.current = record;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    timer.unref();
    record.done = Promise.resolve()
      .then(() => {
        controller.signal.throwIfAborted();

        return prepare(controller.signal);
      })
      .then(() => {
        controller.signal.throwIfAborted();
        if (this.current === record) record.phase = 'ready';
      })
      .catch(() => {
        if (this.current === record) {
          record.phase = 'failed';
          record.retryAfter = Date.now() + 60000;
        }
      })
      .finally(() => clearTimeout(timer));
  }

  stop(): Promise<void> {
    const previous = this.current;

    this.current = undefined;
    previous?.controller.abort();

    return previous ? previous.done : Promise.resolve();
  }
}
