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
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

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

const safeBoundary = (value: string, limit: number, sentences = true): number | null => {
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
      continue;
    }

    // Chat replies are typed one line at a time. Keep lists, tables, headings and
    // fenced code together so a structured answer is not shredded into bubbles.
    const trimmed = line.trim();

    if (
      trimmed &&
      line.endsWith('\n') &&
      !/^\s*(?:[-*+•·]|\d+[.、)])\s+/u.test(line) &&
      !/^\s*#/u.test(line) &&
      !line.includes('|') &&
      characterLength(value.slice(0, position)) <= limit
    ) {
      candidate = position;
    }
  }

  // A plain-text sentence is independently valid Markdown. Never use this
  // fallback while inline Markdown syntax might still be incomplete.
  if (!sentences) return candidate;
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

const oversizedFallback = (value: string, limit: number): [string, string] => {
  const wrapperLength = characterLength('```text\n\n```');

  if (limit <= wrapperLength) {
    return takeCharacters(value, limit);
  }
  const [part, remainder] = takeCharacters(value, limit - wrapperLength);

  return [`\`\`\`text\n${part}\n\`\`\``, remainder];
};

// At close time the whole reply is available, so cap it at maxParts bubbles and
// keep code, lists and tables intact. This is the chat equivalent of a person
// sending a few messages instead of a wall of text.
const finalBubbles = (value: string, limit: number): string[] => {
  const raw = value.replace(/\|\|\|/gu, '\n');

  if (!raw.trim()) return [];
  if (/```|~~~/u.test(raw)) return [raw];
  const text = raw.trim();
  const lines = text
    .split(/\n+/u)
    .map(line => line.trim())
    .filter(Boolean);

  if (lines.length <= 1) return [text];
  const listy = lines.filter(line => /^(?:[-*+•·]|\d+[.、)])/u.test(line)).length;

  if (listy >= Math.ceil(lines.length / 2) || lines.some(line => line.startsWith('|'))) return [text];
  if (lines.length <= limit) return lines;

  return [...lines.slice(0, Math.max(0, limit - 1)), lines.slice(Math.max(0, limit - 1)).join('\n')];
};

export class StreamOutput {
  private buffer = '';
  private readonly timer: ReturnType<typeof setInterval>;
  private sentContent = false;
  private failed = false;
  private stopped = false;
  private detachAbort?: () => void;
  private queue: Promise<void> = Promise.resolve();
  private partsSent = 0;

  constructor(
    private readonly send: SendText,
    private readonly maxMessageLength: number,
    flushIntervalMs: number,
    private readonly onSendError: (error: unknown) => void,
    private readonly maxParts = 5,
    private readonly bubbleDelayMs = 0
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
      if (final) {
        const bubbles = finalBubbles(this.buffer, Math.max(1, this.maxParts - this.partsSent));

        this.buffer = '';
        for (let index = 0; index < bubbles.length; index++) {
          if (this.stopped || this.failed) return;
          await this.sendBubble(bubbles[index]);
          if (index < bubbles.length - 1 && this.bubbleDelayMs > 0 && !this.stopped && !this.failed) {
            await sleep(this.bubbleDelayMs);
          }
        }

        return;
      }
      while (this.buffer && !this.stopped && !this.failed) {
        // The model can mark an intentional bubble break with |||. QQ renders the
        // delimiter literally, so split it here and keep it out of the bubble.
        const delimiter = this.buffer.indexOf('|||');

        if (delimiter !== -1) {
          const part = this.buffer.slice(0, delimiter);

          this.buffer = this.buffer.slice(delimiter + 3).replace(/^\s+/u, '');
          if (part.trim()) await this.sendBubble(part);
          continue;
        }

        if (this.partsSent >= Math.max(1, this.maxParts - 1) && characterLength(this.buffer) <= this.maxMessageLength) {
          return;
        }

        // While streaming, sentence boundaries keep the first bubble responsive.
        const boundary = safeBoundary(this.buffer, this.maxMessageLength, true);

        if (boundary !== null) {
          const part = this.buffer.slice(0, boundary);

          this.buffer = this.buffer.slice(boundary);
          await this.sendBubble(part);
          continue;
        }

        if (characterLength(this.buffer) <= this.maxMessageLength) {
          return;
        }

        const [part, remainder] = oversizedFallback(this.buffer, this.maxMessageLength);

        this.buffer = remainder;
        await this.sendBubble(part);
      }
    };
    const result = this.queue.then(run, run);

    this.queue = result.then(
      () => undefined,
      () => undefined
    );
    await result;
  }

  private async sendBubble(text: string): Promise<void> {
    let rest = /```|~~~/u.test(text) ? text : text.trim();

    if (!rest.trim()) return;

    while (rest && !this.stopped && !this.failed) {
      if (characterLength(rest) <= this.maxMessageLength) {
        await this.sendPart(rest);

        return;
      }
      const [part, remainder] = oversizedFallback(rest, this.maxMessageLength);

      await this.sendPart(part);
      rest = remainder;
    }
  }

  private async sendPart(part: string): Promise<void> {
    if (!part.trim() || this.stopped || this.failed) {
      return;
    }

    try {
      await this.send(part);
      this.sentContent = true;
      this.partsSent += 1;
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
