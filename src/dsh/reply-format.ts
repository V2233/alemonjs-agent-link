import { Format } from 'alemonjs';

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
