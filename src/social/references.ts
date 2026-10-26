import { createConversationService, conversationIdentity, type ConversationEntry, type ReceivedMessage, type MessageReceipt } from 'alemonjs';

export type ReferenceEvent = {
  Platform?: string;
  BotId?: string;
  ChannelId?: string;
  UserId?: string;
  UserName?: string;
  MessageId?: string;
  ReplyId?: string;
  MessageText?: string;
  MessageContent?: ReceivedMessage;
  IsPrivate?: boolean;
  IsBot?: boolean;
};

export class MessageReferences {
  private readonly service = createConversationService({ historyLimit: 1, referenceLimit: 100, contentLimit: 3000, ttlMs: 900000, maxScopes: 1000 });
  private readonly channels = new Map<string, string>();
  private readonly tasks = new Map<string, Promise<unknown>>();
  private pending = 0;

  private track(event: ReferenceEvent): string | undefined {
    const scope = conversationIdentity(event);

    if (scope && event.ChannelId) {
      this.channels.delete(scope);
      this.channels.set(scope, event.ChannelId);
      while (this.channels.size > 1000) {
        this.channels.delete(this.channels.keys().next().value);
      }
    }

    return scope;
  }

  private serialize<T>(scope: string, run: () => Promise<T> | T): Promise<T> {
    if (this.pending >= 2000) {
      return Promise.reject(new Error('消息引用处理队列已满。'));
    }
    this.pending++;
    const task = (this.tasks.get(scope) ?? Promise.resolve()).catch(() => undefined).then(run);
    const completed = task.finally(() => {
      this.pending--;
      if (this.tasks.get(scope) === completed) {
        this.tasks.delete(scope);
      }
    });

    this.tasks.set(scope, completed);

    return completed;
  }

  async capture(event: ReferenceEvent): Promise<{ quote?: ConversationEntry; missingQuote?: string; forwarded: string }> {
    const scope = this.track(event);
    const snapshot = await this.serialize(scope || '', () =>
      this.service.capture({
        ...event,
        MessageContent: { ...event.MessageContent, replyReferenceId: event.MessageContent?.replyReferenceId || event.ReplyId }
      })
    );

    return {
      quote: snapshot.quote?.message,
      missingQuote: snapshot.quote && !snapshot.quote.message ? snapshot.quote.referenceId : undefined,
      forwarded: expandForwardedContent(event.MessageContent)
    };
  }

  async rememberReply(event: ReferenceEvent, receipt: MessageReceipt, text: string): Promise<void> {
    if (!receipt?.id) {
      return;
    }
    const replyEvent = {
      ...event,
      UserId: event.BotId,
      UserName: '机器人',
      IsBot: true,
      MessageId: receipt.id,
      MessageText: text,
      MessageContent: { referenceId: receipt.referenceId }
    };

    await this.serialize(this.track(replyEvent) || '', () => this.service.capture(replyEvent));
  }

  async clear(channelId: string): Promise<void> {
    const pending: Promise<unknown>[] = [];

    for (const [scope, channel] of this.channels) {
      if (channel === channelId) {
        pending.push(this.serialize(scope, () => this.service.store.delete?.(scope)));
        this.channels.delete(scope);
      }
    }
    await Promise.all(pending);
  }
}

// Only expand normalized content supplied by the adapter. Never fetch an
// arbitrary URL or interpret text as a platform API request.
export const expandForwardedContent = (content?: ReceivedMessage): string => {
  const rows: { sender: string; text: string; attachments: string[] }[] = [];
  let remaining = 6000;
  const walk = (message: ReceivedMessage, depth: number): void => {
    if (!message || depth > 3 || !Array.isArray(message.elements)) {
      return;
    }
    for (const element of message.elements.slice(0, 24)) {
      if (rows.length >= 24 || remaining <= 0) {
        break;
      }
      if (message.replyReferenceId && element.referenceId === message.replyReferenceId) {
        continue;
      }
      const text = typeof element.text === 'string' ? element.text.slice(0, Math.min(1000, remaining)) : '';

      if (text || element.attachments?.length) {
        rows.push({
          sender: (element.userName || element.userId || '未知发言人').slice(0, 80),
          text,
          attachments: (element.attachments || []).slice(0, 3).map(item => item.Type)
        });
        remaining -= text.length;
      }
      walk(element.content, depth + 1);
    }
  };

  if (content) {
    walk(content, 0);
  }

  return rows.length ? JSON.stringify(rows) : '';
};

const state = globalThis as typeof globalThis & { __agentLinkMessageReferences__?: MessageReferences };

export const messageReferences = (state.__agentLinkMessageReferences__ ??= new MessageReferences());
