import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import type { OneBotConfig } from './config';

export class OneBotError extends Error {
  constructor(
    readonly kind: 'offline' | 'timeout' | 'rejected' | 'protocol',
    readonly retcode?: number
  ) {
    super(kind === 'rejected' ? `OneBot 拒绝操作（${retcode ?? '未知状态'}）。` : 'OneBot 操作未确认完成。');
  }
}
type Pending = { resolve: (data: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
export class OneBotConnection {
  private socket?: WebSocket;
  private retry?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private alive = true;
  private stopped = true;
  private attempts = 0;
  private pending = new Map<string, Pending>();
  private phase: 'connecting' | 'ready' | 'reconnecting' | 'stopped' = 'stopped';

  constructor(
    readonly config: OneBotConfig,
    private readonly handlers: { event: (value: Record<string, unknown>) => void; ready?: () => void; retryMs?: number }
  ) {}

  status() {
    return { state: this.phase, bots: [{ BotId: this.config.selfId, state: this.phase, transport: 'onebot-v11', reconnectAttempts: this.attempts }] };
  }
  start(): void {
    if (this.stopped) {
      this.stopped = false;
      this.connect();
    }
  }

  stop(): void {
    this.stopped = true;
    this.phase = 'stopped';
    clearTimeout(this.retry);
    clearInterval(this.heartbeat);
    this.socket?.terminate();
    this.rejectPending();
  }

  private rejectPending(): void {
    for (const job of this.pending.values()) {
      clearTimeout(job.timer);
      job.reject(new OneBotError('offline'));
    }
    this.pending.clear();
  }

  private connect(): void {
    if (this.stopped) {
      return;
    }
    this.phase = this.attempts ? 'reconnecting' : 'connecting';
    const socket = new WebSocket(this.config.url, {
      headers: this.config.accessToken ? { Authorization: `Bearer ${this.config.accessToken}` } : {},
      maxPayload: this.config.maxPayloadBytes,
      handshakeTimeout: this.config.timeoutMs,
      followRedirects: false
    });

    this.socket = socket;
    socket.on('error', () => undefined);
    socket.on('pong', () => {
      this.alive = true;
    });
    socket.on('open', () => {
      if (this.socket !== socket || this.stopped) {
        socket.terminate();

        return;
      }
      this.alive = true;
      this.heartbeat = setInterval(() => {
        if (!this.alive) {
          socket.terminate();

          return;
        }
        this.alive = false;
        socket.ping();
      }, 30000);
      this.heartbeat.unref();
      void this.request('get_login_info', {}, true)
        .then(login => {
          if (String((login as { user_id?: unknown })?.user_id) !== this.config.selfId) {
            socket.terminate();

            return;
          }
          if (this.socket !== socket || this.stopped || socket.readyState !== WebSocket.OPEN) {
            return;
          }
          this.phase = 'ready';
          this.attempts = 0;
          this.handlers.ready?.();
        })
        .catch(() => socket.terminate());
    });
    socket.on('message', data => {
      if (this.socket !== socket || this.stopped) {
        return;
      }
      try {
        const value = JSON.parse(data.toString());

        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          return;
        }
        if (typeof value.echo === 'string') {
          const job = this.pending.get(value.echo);

          if (!job) {
            return;
          }
          this.pending.delete(value.echo);
          clearTimeout(job.timer);
          if (value.status === 'ok' && value.retcode === 0) {
            job.resolve(value.data);
          } else if (value.status === 'failed' && Number.isSafeInteger(value.retcode) && value.retcode !== 0) {
            job.reject(new OneBotError('rejected', value.retcode));
          } else {
            job.reject(new OneBotError('protocol'));
          }
        } else if (this.phase === 'ready' && String(value.self_id) === this.config.selfId) {
          this.handlers.event(value);
        }
      } catch {
        /* Invalid frames have no side effects. */
      }
    });
    socket.on('close', () => {
      if (this.socket !== socket) {
        return;
      }
      clearInterval(this.heartbeat);
      this.rejectPending();
      if (this.stopped) {
        return;
      }
      this.phase = 'reconnecting';
      const delay = this.handlers.retryMs ?? Math.min(30000, 1000 * 2 ** Math.min(this.attempts, 5));

      this.attempts++;
      this.retry = setTimeout(() => this.connect(), delay);
      this.retry.unref();
    });
  }

  call(action: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return this.request(action, params);
  }

  private request(action: string, params: Record<string, unknown>, login = false): Promise<unknown> {
    const socket = this.socket;

    if (this.stopped || socket?.readyState !== WebSocket.OPEN || (!login && this.phase !== 'ready')) {
      return Promise.reject(new OneBotError('offline'));
    }
    if (!/^[a-z_][a-z0-9_]{0,63}$/u.test(action) || this.pending.size >= 64) {
      return Promise.reject(new OneBotError('protocol'));
    }
    const echo = randomUUID();
    const body = JSON.stringify({ action, params, echo });

    if (Buffer.byteLength(body) > 32 * 1024 * 1024) {
      return Promise.reject(new OneBotError('protocol'));
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new OneBotError('timeout'));
      }, this.config.timeoutMs);

      this.pending.set(echo, { resolve, reject, timer });
      socket.send(body, error => {
        const job = this.pending.get(echo);

        if (error && job) {
          this.pending.delete(echo);
          clearTimeout(job.timer);
          reject(new OneBotError('offline'));
        }
      });
    });
  }
}
