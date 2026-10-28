import { Format } from 'alemonjs';

/** Bubble delimiters are transport markers, never conversation content. */
export const normalizeBubbleText = (text: string): string => text.replace(/\|\|\|/gu, '\n').trim();

// Legacy history may still suggest a routing prefix. Inspect only that prefix,
// never buffer the whole answer merely to select an already-known recipient.
export class ReplyPrefixFilter {
  private prefix = '';
  private decided = false;
  push(content: string): string {
    if (this.decided) return content;
    this.prefix += content;
    const start = this.prefix.trimStart();

    if (this.prefix.length <= 64 && (!start || '<reply:'.startsWith(start) || /^<reply:m\d*$/u.test(start))) return '';
    this.decided = true;

    return this.prefix.replace(/^\s*<reply:m\d+>\s*/u, '');
  }
}

export const createChatReplyFormat = (text: string, platform?: string, mentionUserId?: string): ReturnType<typeof Format.create> => {
  const format = Format.create();

  if (mentionUserId) format.addMention(mentionUserId).addText('\n');
  // QQ's adapter serializes Mention as a Markdown-only qqbot-at-user tag.
  // A Text-only body selects msg_type=0 and leaks that tag to the recipient.
  // Keep plain-looking prose, but use the framework Markdown envelope for @.
  if (platform === 'qq-bot' && mentionUserId) format.addMarkdownOriginal(text);
  else format.addText(text);

  return format;
};

/** Model-directed voice: the tag is transport metadata, never conversation content. */
export const extractVoiceTag = (text: string): { text: string; voice: boolean } => {
  const voice = /<voice>[\s\S]*?<\/voice>/u.test(text);

  return { text: text.replace(/<\/?voice>/gu, '').trim(), voice };
};

/** Lightweight net-savvy eraser: only removes obvious assistant padding, never code. */
export const polishNetSavvy = (text: string): string => {
  if (/```|~~~/u.test(text)) return text;
  const value = text
    .replace(/^(\s*)作为(?:一个)?AI(?:助手)?[，,]\s*/u, '$1')
    .replace(/^(\s*)好的主人[，,]\s*/u, '$1')
    .replace(/(^|[。！？!?，,]\s*)我这边/gu, '$1我')
    .replace(/我?帮你看看/gu, '我看看')
    .replace(/(?:希望)?(?:这|以上)?(?:能|对你)?有(?:所)?帮助[。！!]?\s*$/u, '')
    .trim();

  return value || text.trim();
};

/** 群聊非直接回复的软上限：不截代码、链接和表格，普通长文在句末收住。 */
export const SOCIAL_REPLY_MAX_CHARS = 220;
export const trimSocialReply = (text: string, maxChars = SOCIAL_REPLY_MAX_CHARS): string => {
  const value = text.trim();

  if (!value || Array.from(value).length <= maxChars || /```|~~~|https?:\/\/|\|.*\|/u.test(value)) {
    return value;
  }
  const head = Array.from(value).slice(0, maxChars).join('');
  const cut = Math.max(...['。', '！', '？', '!', '?', '\n'].map(mark => head.lastIndexOf(mark)));
  const threshold = Math.floor(maxChars * 0.6);

  if (cut >= threshold) {
    return head.slice(0, cut + 1).trim();
  }

  return `${head.replace(/[，,、；;：:\s]+$/u, '')}…`;
};
