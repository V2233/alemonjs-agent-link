import { ResultCode } from 'alemonjs';

// Framework sends resolve with receipts even when the adapter rejects a message.
export const assertMessageDelivered = (receipts: unknown): void => {
  if (!Array.isArray(receipts) || receipts.length === 0 || receipts.some(receipt => receipt?.code !== ResultCode.Ok)) {
    throw new Error('消息发送未得到全部成功回执。');
  }
};

export type SendText = (text: string) => Promise<unknown>;

type Fence = { marker: '`' | '~'; length: number };

const characterLength = (value: string): number => Array.from(value).length;

const takeCharacters = (value: string, limit: number): [string, string] => {
  const characters = Array.from(value);

  return [characters.slice(0, limit).join(''), characters.slice(limit).join('')];
};

const fenceAt = (line: string): Fence | null => {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})[^\n]*\n?$/);

  return match ? { marker: match[1][0] as Fence['marker'], length: match[1].length } : null;
};

const closesFence = (line: string, fence: Fence): boolean => {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})\s*\n?$/);

  return match?.[1][0] === fence.marker && match[1].length >= fence.length;
};

const safeBoundary = (value: string, limit: number): number | null => {
  let position = 0;
  let candidate: number | null = null;
  let fence: Fence | null = null;

  for (const line of value.split(/(?<=\n)/u)) {
    position += line.length;
    const opener = fenceAt(line);

    if (fence) {
      if (closesFence(line, fence) && characterLength(value.slice(0, position)) <= limit) {
        candidate = position;
        fence = null;
      }
      continue;
    }

    if (opener) {
      fence = opener;
      continue;
    }

    if (/^\s*\n$/u.test(line) && characterLength(value.slice(0, position)) <= limit) {
      candidate = position;
    }
  }

  // A plain-text sentence is independently valid Markdown. Never use this
  // fallback while inline Markdown syntax might still be incomplete.
  const hasInlineMarkdown = ['`', '*', '_', '~', '[', ']', '<', '>'].some(token => value.includes(token));

  if (!fence && !hasInlineMarkdown) {
    for (const match of value.matchAll(/[。！？!?](?=\s|$)/gu)) {
      const end = match.index + match[0].length;

      if (characterLength(value.slice(0, end)) <= limit) {
        candidate = Math.max(candidate ?? 0, end);
      }
    }
  }

  return candidate;
};

const finalMarkdown = (value: string): string => {
  let fence: Fence | null = null;

  for (const line of value.split(/(?<=\n)/u)) {
    const opener = fenceAt(line);

    if (!fence && opener) {
      fence = opener;
    } else if (fence && closesFence(line, fence)) {
      fence = null;
    }
  }

  return fence ? `${value}${value.endsWith('\n') ? '' : '\n'}${fence.marker.repeat(fence.length)}` : value;
};

const oversizedFallback = (value: string, limit: number): [string, string] => {
  const wrapperLength = characterLength('```text\n\n```');

  if (limit <= wrapperLength) {
    return takeCharacters(value, limit);
  }
  const [part, remainder] = takeCharacters(value, limit - wrapperLength);

  return [`\`\`\`text\n${part}\n\`\`\``, remainder];
};

export class StreamOutput {
  private buffer = '';
  private readonly timer: ReturnType<typeof setInterval>;
  private sentContent = false;
  private failed = false;
  private stopped = false;
  private detachAbort?: () => void;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly send: SendText,
    private readonly maxMessageLength: number,
    flushIntervalMs: number,
    private readonly onSendError: (error: unknown) => void
  ) {
    this.timer = setInterval(() => {
      void this.flush(false);
    }, flushIntervalMs);
  }

  append(content: string): void {
    if (!this.stopped && !this.failed) {
      this.buffer += content;
    }
  }

  bindSignal(signal: AbortSignal): void {
    this.detachAbort?.();
    const stop = (): void => this.abort();

    signal.addEventListener('abort', stop, { once: true });
    this.detachAbort = () => signal.removeEventListener('abort', stop);
    if (signal.aborted) {
      this.abort();
    }
  }

  abort(): void {
    this.stopped = true;
    this.buffer = '';
    clearInterval(this.timer);
    this.detachAbort?.();
  }

  async flush(final = false): Promise<void> {
    const run = async (): Promise<void> => {
      while (this.buffer && !this.stopped && !this.failed) {
        const boundary = safeBoundary(this.buffer, this.maxMessageLength);

        if (boundary !== null) {
          const part = this.buffer.slice(0, boundary);

          this.buffer = this.buffer.slice(boundary);
          await this.sendPart(part);
          continue;
        }

        if (!final && characterLength(this.buffer) <= this.maxMessageLength) {
          return;
        }

        if (final) {
          const complete = finalMarkdown(this.buffer);

          if (characterLength(complete) <= this.maxMessageLength) {
            this.buffer = '';
            await this.sendPart(complete);
            continue;
          }
        }

        const [part, remainder] = oversizedFallback(this.buffer, this.maxMessageLength);

        this.buffer = remainder;
        await this.sendPart(part);
      }
    };
    const result = this.queue.then(run, run);

    this.queue = result.then(
      () => undefined,
      () => undefined
    );
    await result;
  }

  private async sendPart(part: string): Promise<void> {
    if (!part.trim() || this.stopped || this.failed) {
      return;
    }

    try {
      await this.send(part);
      this.sentContent = true;
    } catch (error) {
      this.failed = true;
      this.buffer = '';
      clearInterval(this.timer);
      this.onSendError(error);
    }
  }

  async close(): Promise<boolean> {
    clearInterval(this.timer);
    await this.flush(true);

    this.detachAbort?.();

    return this.sentContent && !this.failed && !this.stopped;
  }
}
