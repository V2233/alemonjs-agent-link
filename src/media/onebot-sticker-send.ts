import { ResultCode, useClient } from 'alemonjs';

type StickerSendEvent = { Platform?: string };
type StickerSendClient = {
  agentLink: {
    sendSticker(args: { data: string; replyId?: string }): Promise<unknown>;
  };
};

/**
 * Send an image as a OneBot sticker segment (`sub_type=1`). Returns undefined when the current
 * platform/gateway cannot handle the dedicated action, so callers can fall back to normal media.
 */
export const sendOnebotSticker = async (event: StickerSendEvent, data: Buffer, replyId?: string): Promise<{ messageId: string } | undefined> => {
  if (event.Platform !== 'onebot' || data.length === 0 || data.length > 5 * 1024 * 1024) return undefined;
  try {
    const [client] = useClient<StickerSendClient>(event as never);
    const result = (await client.agentLink.sendSticker({ data: data.toString('base64'), ...(replyId ? { replyId } : {}) })) as {
      code: number;
      data?: { messageId?: unknown };
    }[];

    if (!Array.isArray(result) || result.length !== 1 || result[0].code !== ResultCode.Ok) return undefined;
    const messageId = result[0].data?.messageId;

    return typeof messageId === 'string' && messageId ? { messageId } : undefined;
  } catch {
    return undefined;
  }
};
