import { ResultCode, logger, useClient, type StreamReceipt, type useMessage } from 'alemonjs';

type Sender = ReturnType<typeof useMessage>[0]['stream'];
export const supportsQQStream = (
  event: { Platform?: string; IsPrivate?: boolean; MessageId?: string; Target?: { scope: string } },
  available: boolean
): boolean => available && event.Platform === 'qq-bot' && Boolean(event.IsPrivate && event.MessageId) && (!event.Target || event.Target.scope === 'c2c');

// Reserve through the adapter's shared counter so later ordinary replies cannot reuse it.
export const createQQSequenceAllocator = (replyId: string): (() => Promise<number>) => {
  const [client] = useClient<{ getMessageSeq(id: string): Promise<Array<{ code: number; data: number }>> }>();

  return async () => {
    const [result] = await client.getMessageSeq(replyId);

    if (result?.code !== ResultCode.Ok || !Number.isInteger(result.data) || result.data < 1) {
      throw new Error('QQ 消息序号分配失败');
    }

    return result.data;
  };
};

// Coalesce while a network request is in flight; first delta is sent immediately.
export class QQStreamOutput {
  private text = '';
  private sent = '';
  private id?: string;
  private index = 0;
  private sequence?: number;
  private stopped = false;
  private failed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private task: Promise<void> = Promise.resolve();
  private busy = false;
  private lastSentAt = 0;
  private detach?: () => void;
  private receipt?: StreamReceipt;
  constructor(
    private send: Sender,
    private replyId: string,
    private maxBytes: number,
    private onDelivered: (receipt: StreamReceipt, text: string) => Promise<void>,
    private allocateSequence: () => Promise<number>
  ) {}

  append(delta: string): void {
    if (this.stopped || this.failed) {
      return;
    }
    this.text += delta;
    if (Buffer.byteLength(this.text) > this.maxBytes) {
      this.failed = true;

      return;
    }
    this.schedule();
  }
  bindSignal(signal: AbortSignal): void {
    this.detach?.();
    const abort = (): void => this.abort();

    signal.addEventListener('abort', abort, { once: true });
    this.detach = () => signal.removeEventListener('abort', abort);
    if (signal.aborted) {
      this.abort();
    }
  }
  private schedule(): void {
    if (this.busy || this.timer || this.stopped || this.failed || this.text === this.sent) {
      return;
    }
    const delay = Math.max(0, 500 - (Date.now() - this.lastSentAt));

    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.busy = true;
      this.task = this.update(false)
        .catch(() => {
          logger.warn({ index: this.index }, 'QQ stream update failed');
          this.failed = true;
        })
        .finally(() => {
          this.busy = false;
          this.schedule();
        });
    }, delay);
  }
  private async update(complete: boolean): Promise<void> {
    if (this.stopped || this.failed || !this.text) {
      return;
    }
    const snapshot = this.text;

    this.sequence ??= await this.allocateSequence();
    if (this.stopped) {
      return;
    }
    this.lastSentAt = Date.now();
    const result = await this.send({
      text: snapshot,
      mode: 'replace',
      state: complete ? 'complete' : 'generating',
      contentType: 'text',
      sequence: this.sequence,
      index: this.index,
      streamId: this.id,
      replyId: this.replyId
    });

    if (result.code !== ResultCode.Ok || !result.data?.id) {
      throw new Error('QQ 流发送失败');
    }
    this.id ||= result.data.id;
    this.index++;
    this.sent = snapshot;
    this.receipt = result.data;
    // remainingLength describes queued delivery; zero is a normal successful receipt.
  }
  async close(): Promise<boolean> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.task;
    // The completion update follows the same pacing rule as generating updates.
    if (this.stopped || this.failed || !this.text) {
      this.abort();

      return false;
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const delay = Math.max(0, 500 - (Date.now() - this.lastSentAt));

    if (delay) {
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    try {
      await this.update(true);
      if (this.stopped || this.failed || !this.receipt) {
        return false;
      }
      await this.onDelivered(this.receipt, this.sent);

      return true;
    } catch {
      return false;
    } finally {
      this.abort();
    }
  }
  abort(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.detach?.();
  }
}
